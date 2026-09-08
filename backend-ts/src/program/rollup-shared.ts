/** Shared rollup helpers used by both the programs overview and the hierarchy rollup,
 *  so the two read-models can't silently diverge on which runs/rates they count. */
/**
 * The scopes whose runs describe the WHOLE roster and may therefore be a measure's population winner
 * (the roster, the programs overview, the hierarchy rollup, the quality snapshot). An ALLOWLIST, not
 * "everything but the rerun scopes" (#150 C4's original rule): a SITE run is one clinic and a
 * CASE/EMPLOYEE run is one person, and until 2026-09-08 a newer COMPLETED SITE run replaced the
 * practice-wide snapshot with its own clinic (review finding 11, ADR-077 d4). A future scope is out
 * until it is deliberately admitted. Compared case-insensitively: the Java backend persisted some
 * scope values lowercase.
 */
export const POPULATION_SCOPES: ReadonlySet<string> = new Set(["MEASURE", "ALL_PROGRAMS"]);
export const isPopulationRun = (scopeType: string): boolean => POPULATION_SCOPES.has(scopeType.toUpperCase());
/** compliant / denominator × 100, 1 decimal; 0 when denominator is 0. */
export const round1 = (compliant: number, total: number): number => (total === 0 ? 0 : Math.round((compliant / total) * 1000) / 10);

export interface ComplianceRateCounts {
  compliant: number;
  dueSoon?: number;
  overdue?: number;
  missingData?: number;
  excluded?: number;
}

/**
 * The WORKFLOW-STATUS rate: compliant / (compliant + dueSoon + overdue + missingData), as a percentage
 * rounded to 1 decimal (round1); 0 when the denominator is 0.
 *
 * This is NOT the CMS proportion — it reduces the five operational buckets, not the measure's
 * population membership, and for an inverse measure (cms122) "compliant" is not its numerator. The
 * evidence-based rate is `officialMeasureRate` (`program/measure-rate.ts`), and the two are shown as
 * different metrics (ADR-077 d5); an earlier comment here calling this "the way CMS scores it" was wrong.
 */
export function complianceRateOf(counts: ComplianceRateCounts): number {
  const denominator =
    (counts.compliant ?? 0) +
    (counts.dueSoon ?? 0) +
    (counts.overdue ?? 0) +
    (counts.missingData ?? 0);
  if (denominator <= 0) return 0;
  return round1(counts.compliant, denominator);
}

/** Day-granular (YYYY-MM-DD) slice of an ISO timestamp. */
export const day = (s: string): string => s.slice(0, 10);

/** A run that finished a full pass (COMPLETED or PARTIAL_FAILURE) — proposals/exports should only
 *  derive from terminal population runs, never an in-flight RUNNING run's partial outcomes. */
export const isCompletedRun = (status: string): boolean =>
  status.toUpperCase() === "COMPLETED" || status.toUpperCase() === "PARTIAL_FAILURE";

/** The rows of the most-recent run (by runStartedAt) among the given rows; [] if none.
 *  Shared by the hierarchy rollup and the order-proposal route so "latest population run" can't drift. */
export function latestRunRows<T extends { runId: string; runStartedAt: string }>(rows: T[]): T[] {
  const byRun = new Map<string, { startedAt: string; rows: T[] }>();
  for (const r of rows) {
    const g = byRun.get(r.runId) ?? byRun.set(r.runId, { startedAt: r.runStartedAt, rows: [] }).get(r.runId)!;
    g.rows.push(r);
  }
  let best: { startedAt: string; rows: T[] } | null = null;
  for (const g of byRun.values()) if (!best || g.startedAt > best.startedAt) best = g;
  return best?.rows ?? [];
}
