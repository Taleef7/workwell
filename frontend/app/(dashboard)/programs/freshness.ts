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

/** With no schedule known, a nightly runs every 24 hours; past 36 without a new one, one has been missed. */
export const OVERDUE_AFTER_MS = 36 * 60 * 60 * 1000;

/**
 * The nightly's schedule, from `GET /api/runs/schedule`: its UTC hour, its weekdays (null = every day)
 * and the scheduler's debounce floor, so this page and the scheduler agree on when a run is due.
 */
export interface NightlySchedule {
  anchorHourUtc: number;
  days: number[] | null;
  minGapMs?: number;
}

/** How long past a scheduled nightly's start its absence is still not a missed run. */
export const SCHEDULED_GRACE_MS = 12 * 60 * 60 * 1000;

/** The scheduler's own floor (`DEFAULT_MIN_GAP_MS`, backend `admin/scheduler.ts`), for an older server that does not send it. */
const SCHEDULER_MIN_GAP_MS = 23.5 * 60 * 60 * 1000;

/**
 * When the scheduler next runs after a run that started at `startedMs`: its own rule (`dueAtMs`),
 * restated. The day's hour is still owed only if the run started before it AND at least the floor
 * (23.5 h) before it; otherwise the next day's. Then any day off the schedule is skipped, so on a
 * weekdays-only deployment Friday's run is followed by Monday's and the weekend is not "no update".
 */
export function nextScheduledAfter(startedMs: number, schedule: NightlySchedule): number {
  const start = new Date(startedMs);
  const anchorOn = (day: number) => Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + day, schedule.anchorHourUtc);
  const minGap = schedule.minGapMs ?? SCHEDULER_MIN_GAP_MS;
  const owedToday = anchorOn(0);
  let offset = startedMs < owedToday && owedToday - startedMs >= minGap ? 0 : 1;
  while (schedule.days && !schedule.days.includes(new Date(anchorOn(offset)).getUTCDay()) && offset < 8) offset++;
  return anchorOn(offset);
}

const upper = (s: string) => s.trim().toUpperCase();
const DID_NOT_FINISH = new Set(["FAILED", "CANCELLED"]);
const REPORTABLE = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

export function freshnessNotice(
  runsNewestFirst: readonly FreshnessRun[],
  now: number = Date.now(),
  schedule: NightlySchedule | null = null,
): FreshnessNotice | null {
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
  if (!Number.isFinite(started)) return null;
  // A finished update is judged against the schedule when the deployment names its weekdays; a run
  // still "in progress" past a day is stuck whatever the schedule, so it keeps the daily rule.
  const overdue = schedule?.days && status === "COMPLETED"
    ? now > nextScheduledAfter(started, schedule) + SCHEDULED_GRACE_MS
    : now - started > OVERDUE_AFTER_MS;
  return overdue ? { kind: "overdue", latestAt: newest.startedAt } : null;
}
