/**
 * A run's outcome counts for the Run History list (#644).
 *
 * The list counted EVERY listed run's outcomes on every load, all at once: one GROUP BY over up to
 * 120,000 rows per run, under `Promise.all`. On the pilot that was 9.3 s for 38 runs cold (2.9 s warm),
 * and during the 2026-09-25 all-programs run the burst held all ten pool connections, so the page, and
 * anything else asking at that moment, got "No database connection was available in time". Thirty-seven
 * of those runs were finished; their counts cannot change.
 *
 * So a FINISHED run's counts are kept, and only a running run's are read each time. Two things can still
 * change a finished run's rows, and both are covered: outcome compaction (ADR-073), which calls
 * `resetRunOutcomeCounts`, and a one-shot maintenance script run from the CLI in another process (the
 * ADR-079 out-of-population backfill), which this process cannot see, so an entry also expires after
 * `COUNTS_TTL_MS`. The counts that do have to be read are read a few at a time, like the runs CSV
 * (export-csv.ts), so a list load can never take the whole pool.
 */
import type { OutcomeStatusCount, OutcomeStore } from "../stores/outcome-store.ts";

const FINISHED = new Set(["COMPLETED", "PARTIAL_FAILURE", "FAILED", "CANCELLED"]);

/** How long a finished run's counts are trusted without compaction having said otherwise. */
export const COUNTS_TTL_MS = 10 * 60_000;
/** Count queries a list load may have in flight at once, out of the pool's ten connections. */
export const COUNTS_CONCURRENCY = 3;
const MAX_ENTRIES = 2_000;

const memo = new Map<string, { counts: OutcomeStatusCount[]; at: number }>();
/**
 * Bumped by every reset. A count read that started before a reset may carry the pre-compaction rows
 * (its query saw the old snapshot), so it is not kept if the generation moved while it was in flight
 * (Codex on #709): otherwise it would restore the stale count for the whole TTL.
 */
let generation = 0;

export function isFinishedRunStatus(status: string): boolean {
  return FINISHED.has(status.toUpperCase());
}

/** One run's counts: kept when the run is finished, read every time while it is not. */
export async function runOutcomeCounts(
  store: Pick<OutcomeStore, "countOutcomesByStatus">,
  run: { id: string; status: string },
  now: number = Date.now(),
): Promise<OutcomeStatusCount[]> {
  const finished = isFinishedRunStatus(run.status);
  if (finished) {
    const hit = memo.get(run.id);
    if (hit && now - hit.at < COUNTS_TTL_MS) return hit.counts;
  }
  const startedIn = generation;
  const counts = await store.countOutcomesByStatus(run.id);
  if (finished && startedIn === generation) {
    memo.delete(run.id);
    memo.set(run.id, { counts, at: now });
    while (memo.size > MAX_ENTRIES) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
  }
  return counts;
}

/** Many runs' counts, in the runs' order, with at most `COUNTS_CONCURRENCY` queries in flight. */
export async function runOutcomeCountsFor(
  store: Pick<OutcomeStore, "countOutcomesByStatus">,
  runs: ReadonlyArray<{ id: string; status: string }>,
  concurrency: number = COUNTS_CONCURRENCY,
): Promise<OutcomeStatusCount[][]> {
  const out: OutcomeStatusCount[][] = new Array(runs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < runs.length) {
      const i = next++;
      out[i] = await runOutcomeCounts(store, runs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, runs.length)) }, lane));
  return out;
}

/** Outcome compaction deleted rows from finished runs: every kept count may now be wrong. */
export function resetRunOutcomeCounts(): void {
  generation += 1;
  memo.clear();
}
