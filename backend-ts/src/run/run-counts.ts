/**
 * A run's outcome counts for the Run History list (#644).
 *
 * The list counted EVERY listed run's outcomes on every load, all at once: one GROUP BY over up to
 * 120,000 rows per run, under `Promise.all`. On the pilot that was 9.3 s for 38 runs cold (2.9 s warm),
 * and during the 2026-09-25 all-programs run the burst held all ten pool connections, so the page, and
 * anything else asking at that moment, got "No database connection was available in time". Thirty-seven
 * of those runs were finished; their counts cannot change.
 *
 * So a FINISHED run's counts are kept until something says they changed, and only a running run's are
 * read each time. Outcome compaction (ADR-073), the one in-process path that changes a finished run's
 * rows, calls `resetRunOutcomeCounts`. A change made from another process is seen at the next restart:
 * the ADR-079 backfill (DEPLOY.md already requires one after it) and the seeding scripts, which create a
 * run COMPLETED and then insert its rows (backfill-trend-history). Kept entries used to expire after ten
 * minutes for that second case, which made nearly every visit a cold one: 48.8 s for the first page on
 * the pilot (2026-09-26), against 0.48 s kept. The counts that do have to be read are read a few at a
 * time, like the runs CSV (export-csv.ts), so a list load can never take the whole pool, and two loads
 * asking for the same run at once share one read.
 */
import type { OutcomeStatusCount, OutcomeStore } from "../stores/outcome-store.ts";

const FINISHED = new Set(["COMPLETED", "PARTIAL_FAILURE", "FAILED", "CANCELLED"]);

/** Count queries a list load may have in flight at once, out of the pool's ten connections. */
export const COUNTS_CONCURRENCY = 3;
const MAX_ENTRIES = 2_000;

/**
 * Keyed by run AND status, so a count is kept only for the status it was read under. Boot recovery can
 * mark a stuck run FAILED and then, when its audit write fails, restore it for a retry
 * (recover-stuck-runs.ts); a count kept under that brief FAILED must not answer for the run once it has
 * finished for real. Not covered: the retry failing again, to FAILED, which would show the count from
 * before it ran. That takes a failed audit write and a second failure together; a restart clears it.
 */
const memo = new Map<string, OutcomeStatusCount[]>();
/**
 * Reads in flight, under the same key, so a finished run never joins a read that began while it was
 * still running. Run History asks for the list twice on load
 * (its grid, and the app-wide run-status check every page makes), and each used to count the same
 * runs separately.
 */
const inFlight = new Map<string, Promise<OutcomeStatusCount[]>>();
/**
 * Bumped by every reset. A count read that started before a reset may carry the pre-compaction rows
 * (its query saw the old snapshot), so it is not kept if the generation moved while it was in flight
 * (Codex on #709): otherwise it would restore the stale count until the next restart.
 */
let generation = 0;

export function isFinishedRunStatus(status: string): boolean {
  return FINISHED.has(status.toUpperCase());
}

/** One run's counts: kept when the run is finished, read every time while it is not. */
export async function runOutcomeCounts(
  store: Pick<OutcomeStore, "countOutcomesByStatus">,
  run: { id: string; status: string },
): Promise<OutcomeStatusCount[]> {
  const finished = isFinishedRunStatus(run.status);
  const key = `${run.id}|${run.status.toUpperCase()}`;
  if (finished) {
    const hit = memo.get(key);
    if (hit) return hit;
  }
  const shared = inFlight.get(key);
  if (shared) return shared;
  const startedIn = generation;
  const read = store.countOutcomesByStatus(run.id).then((counts) => {
    if (finished && startedIn === generation) {
      memo.delete(key);
      memo.set(key, counts);
      while (memo.size > MAX_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest === undefined) break;
        memo.delete(oldest);
      }
    }
    return counts;
  });
  inFlight.set(key, read);
  // Cleared whichever way the read ends, and only if a reset has not already replaced it.
  const clear = () => {
    if (inFlight.get(key) === read) inFlight.delete(key);
  };
  read.then(clear, clear);
  return read;
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
  inFlight.clear();
}
