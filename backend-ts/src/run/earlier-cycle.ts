import { bucketPeriodForMeasure, isEarlierCycle } from "./compliance-period.ts";

/**
 * A run that scores a cycle which has already ended (#882, LOCKED_DECISIONS §4A.10): last year re-scored
 * in January so that late records reach last year's numbers. Its outcomes are real and the scorecard and
 * the list report for that year select it by period, but it is nobody's "latest": the roster, Programs,
 * the trend, CDS cards, MCP and the snapshots stay on the current year's run, however recently this one
 * started.
 *
 * The marker is `requestedScope.earlierCycle: true`, written ONLY by the server through this module: the
 * pipeline's run creation, the re-check's run, and `POST /api/runs`. A client value is stripped
 * (`withoutServerScopeKeys`). The store's "latest" reads compare it to the JSON boolean `true`, so a
 * string or a number never matches.
 */

/** `requestedScope` keys only the server writes: the practice's date the run was planned on, and the marker. */
const SERVER_SCOPE_KEYS = ["today", "earlierCycle"] as const;

/** A client's requested scope without the keys only the server may set. */
export function withoutServerScopeKeys(scope: Record<string, unknown>): Record<string, unknown> {
  const out = { ...scope };
  for (const key of SERVER_SCOPE_KEYS) delete out[key];
  return out;
}

/** The measures among `measureIds` whose cycle at `evaluationDate` has already ended on `today`. */
export function earlierCycleMeasures(measureIds: readonly string[], evaluationDate: string, today: string): string[] {
  return [...new Set(measureIds)].filter((m) => isEarlierCycle(m, bucketPeriodForMeasure(m, evaluationDate), today));
}

/** The marker to spread into a run's `requestedScope`: present only when some measure scores an earlier cycle. */
export function earlierCycleScope(
  measureIds: readonly string[],
  evaluationDate: string,
  today: string,
): { earlierCycle?: true } {
  return earlierCycleMeasures(measureIds, evaluationDate, today).length > 0 ? { earlierCycle: true } : {};
}

/** Whether a run carries the marker (the JSON boolean `true`, as the store reads compare it). */
export function isEarlierCycleRun(run: { requestedScope?: Record<string, unknown> | null } | null | undefined): boolean {
  return run?.requestedScope?.earlierCycle === true;
}
