/**
 * Whether the numbers on /programs are the latest overnight update's, and if not, why (#623).
 *
 * A failed nightly leaves the previous run's results in place, which is the right fallback and a
 * silent one: the page kept showing yesterday's answer with nothing to say so, and the failure alert
 * reached nobody. This decides what the reader is told; the page only renders it.
 *
 * Reads the newest whole-practice runs (ALL_PROGRAMS, nightly or manual), newest first. A run in
 * progress says nothing (the run indicator already does) unless it has been "in progress" for longer
 * than a cycle, which is a stuck run and stale numbers. A single-measure run is never read.
 */
export interface FreshnessRun {
  status: string;
  startedAt: string;
}

export type FreshnessNotice =
  /** The newest update ended FAILED or CANCELLED; the numbers are an older update's. */
  | { kind: "failed"; latestAt: string; dataFromAt: string | null }
  /** The newest update finished, but some patients could not be evaluated. */
  | { kind: "partial"; latestAt: string }
  /** Nothing has run for longer than a nightly cycle allows. */
  | { kind: "overdue"; latestAt: string }
  /** No whole-practice update has ever run: whatever is shown came from runs started by hand. */
  | { kind: "none" };

/** A nightly runs every 24 hours; past 36 without a new one, one has been missed. */
export const OVERDUE_AFTER_MS = 36 * 60 * 60 * 1000;

const upper = (s: string) => s.trim().toUpperCase();
const DID_NOT_FINISH = new Set(["FAILED", "CANCELLED"]);
const REPORTABLE = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

export function freshnessNotice(runsNewestFirst: readonly FreshnessRun[], now: number = Date.now()): FreshnessNotice | null {
  const newest = runsNewestFirst[0];
  // Silence here would last forever on a deployment whose scheduler never created its first run
  // (Codex on #710). A deployment with the scheduler off (staging) has no update to be late for, and
  // saying so is still true.
  if (!newest) return { kind: "none" };
  const status = upper(newest.status);
  if (DID_NOT_FINISH.has(status)) {
    // The dashboard shows the newest REPORTABLE run's results; name it, or say there is none listed.
    const shown = runsNewestFirst.find((r) => REPORTABLE.has(upper(r.status)));
    return { kind: "failed", latestAt: newest.startedAt, dataFromAt: shown?.startedAt ?? null };
  }
  if (status === "PARTIAL_FAILURE") return { kind: "partial", latestAt: newest.startedAt };
  const started = Date.parse(newest.startedAt);
  if (Number.isFinite(started) && now - started > OVERDUE_AFTER_MS) return { kind: "overdue", latestAt: newest.startedAt };
  return null;
}
