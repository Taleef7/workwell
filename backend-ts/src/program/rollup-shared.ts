/** Shared rollup helpers used by both the programs overview and the hierarchy rollup,
 *  so the two read-models can't silently diverge on which runs/rates they count. */
export const RERUN_SCOPES = new Set(["CASE", "EMPLOYEE"]);
/** Single-subject CASE/EMPLOYEE rerun-to-verify runs are excluded from population rollups
 *  (#150 C4). Compared case-insensitively: the Java backend persists these lowercase. */
export const isPopulationRun = (scopeType: string): boolean => !RERUN_SCOPES.has(scopeType.toUpperCase());
/** compliant/total × 100, 1 decimal; 0 when total is 0. */
export const round1 = (compliant: number, total: number): number => (total === 0 ? 0 : Math.round((compliant / total) * 1000) / 10);
/** Day-granular (YYYY-MM-DD) slice of an ISO timestamp. */
export const day = (s: string): string => s.slice(0, 10);

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
