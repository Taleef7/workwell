/**
 * A finished run's per-measure read for the scorecard, kept in the worker (#884, owner decision 2026-11-03).
 *
 * The scorecard read each measure's 20,000 evidence rows on every load: 5.1–5.3 s at Maui's shape on a
 * quarter-CPU Postgres, 7.5–8.5 s live, 95% of it that read. A finished run's rows do not change: outcome
 * rows are only inserted, a run is finalized after its last chunk is written, and `/evaluate` and
 * `/import` refuse a terminal run. Compaction is the one path that deletes them, and the scorecard checks it
 * from the audit ledger on every request, before and after the read, so a kept read is never shown for a
 * run a compaction reached, whichever process ran it. What is kept is `readMeasureYearRows`' answer for
 * (run, measure, year): nothing in it depends on the request, the directory or the clock. A kept load takes
 * about 0.25 s.
 *
 * Shapes, as Run History's counts (`run/run-counts.ts`), which rest on the same immutability:
 *
 * - **One entry per (measure, year)**, holding the run it was read from. The scorecard only ever moves to
 *   a newer run, so a newer run replaces the entry and an older one never does: a request that chose last
 *   night's run but finished after the warm kept tonight's cannot put it back, and a nightly frees the
 *   previous run's rows rather than doubling them. "Newer" is the store's order, `started_at DESC, id DESC`.
 * - **One read in flight per (run, measure, year)**: a visitor who opens the card while the warm reads it
 *   joins that read instead of starting a second against the same database. A joiner whose shared read
 *   failed tries once more on its own, so the warm's timeout is not every visitor's error; a failed read is
 *   never kept.
 * - **A reset** (compaction) drops everything, and a read that began before it is not kept.
 * - **A bound**: `maxEntries`, least recently used first, taking entries outside `protectedYears` first,
 *   so browsing older years never evicts the year the practice is working. One year of Maui's six measures
 *   at 20,000 patients holds about 31 MB.
 *
 * Not covered, as for Run History's counts: a change from another process other than compaction (hand SQL
 * on runs or outcomes) is seen at the next restart, which DEPLOY.md requires; and `/evaluate` checks the
 * run's status before the engine runs, so a row can land just after a run finalizes.
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { readMeasureYearRows, type MeasureYearRows, type SelectedRun } from "./measure-year-rates.ts";

interface Entry {
  runId: string;
  /** `Date.parse` of the run's `startedAt`: the order the store selects by. */
  startedAt: number;
  year: number;
  value: MeasureYearRows;
}

export interface MeasureYearRowsCacheOptions {
  /** How many (measure, year) entries are kept. Read at each insert, so it follows the routed measures. */
  maxEntries: () => number;
  /** Years evicted last: the year the practice is working, and last year while it closes out. */
  protectedYears: () => ReadonlySet<number>;
}

/** True when run `a` sorts after run `b` in the store's `started_at DESC, id DESC` order, i.e. is newer. */
function isNewerRun(aAt: number, aId: string, bAt: number, bId: string): boolean {
  return aAt !== bAt ? aAt > bAt : aId > bId;
}

export class MeasureYearRowsCache {
  /** Keyed `measureId|year`; Map order is recency, least recent first. */
  private readonly entries = new Map<string, Entry>();
  /** Keyed `runId|measureId|year`. */
  private readonly inFlight = new Map<string, Promise<MeasureYearRows>>();
  /** Bumped by every reset; a read that began under an older generation is not kept. */
  private generation = 0;

  constructor(private readonly options: MeasureYearRowsCacheOptions) {}

  /** `readMeasureYearRows(outcomes, run.runId, measureId, year)` over every subject, kept for a finished run. */
  async rows(
    outcomes: Pick<OutcomeStore, "listOutcomeSubjectMembershipsForRun">,
    run: Pick<SelectedRun, "runId" | "startedAt">,
    measureId: string,
    year: number,
  ): Promise<MeasureYearRows> {
    const slot = `${measureId}|${year}`;
    const held = this.entries.get(slot);
    if (held && held.runId === run.runId) {
      this.entries.delete(slot);
      this.entries.set(slot, held);
      return held.value;
    }
    const key = `${run.runId}|${measureId}|${year}`;
    const shared = this.inFlight.get(key);
    if (shared) {
      try {
        return await shared;
      } catch {
        // The failed read has left `inFlight` by now (its own handler ran first). Another joiner may
        // already have started the second read; join that one rather than start a third.
        return this.inFlight.get(key) ?? this.read(outcomes, run, measureId, year, key);
      }
    }
    return this.read(outcomes, run, measureId, year, key);
  }

  /** Compaction deleted rows from finished runs: nothing kept may describe them any more. */
  reset(): void {
    this.generation += 1;
    this.entries.clear();
    this.inFlight.clear();
  }

  /** Test seam: how many (measure, year) entries are held. */
  get size(): number {
    return this.entries.size;
  }

  private read(
    outcomes: Pick<OutcomeStore, "listOutcomeSubjectMembershipsForRun">,
    run: Pick<SelectedRun, "runId" | "startedAt">,
    measureId: string,
    year: number,
    key: string,
  ): Promise<MeasureYearRows> {
    const startedIn = this.generation;
    const read = readMeasureYearRows(outcomes, run.runId, measureId, year).then((value) => {
      if (startedIn === this.generation) this.keep(`${measureId}|${year}`, { runId: run.runId, startedAt: Date.parse(run.startedAt), year, value });
      return value;
    });
    this.inFlight.set(key, read);
    const clear = () => {
      if (this.inFlight.get(key) === read) this.inFlight.delete(key);
    };
    read.then(clear, clear);
    return read;
  }

  private keep(slot: string, entry: Entry): void {
    const held = this.entries.get(slot);
    if (held && held.runId !== entry.runId && !isNewerRun(entry.startedAt, entry.runId, held.startedAt, held.runId)) return;
    this.entries.delete(slot);
    this.entries.set(slot, entry);
    const max = Math.max(1, this.options.maxEntries());
    if (this.entries.size <= max) return;
    const protectedYears = this.options.protectedYears();
    while (this.entries.size > max) {
      let victim: string | undefined;
      for (const [k, e] of this.entries) {
        if (k !== slot && !protectedYears.has(e.year)) {
          victim = k;
          break;
        }
      }
      if (victim === undefined) {
        for (const k of this.entries.keys()) {
          if (k !== slot) {
            victim = k;
            break;
          }
        }
      }
      if (victim === undefined) break;
      this.entries.delete(victim);
    }
  }
}
