/**
 * Test support: a fake outcome store's `listLatestPopulationRuns`, derived from the rows the fake
 * serves through `listOutcomesWithRun`. It is the reference reduction the store contract pins the
 * real stores to (population scope, terminal status, the started-day window, the trigger
 * exclusions, newest first by started_at then run id), so a read-model test that hands a fake a row
 * set gets the same winners the SQL would name — and a fake that returns rows regardless of
 * `runIds` still exercises the read model's own (measure, run) filter.
 */
import type { LatestPopulationRun, OutcomeMeasureFilter, OutcomeWithRun } from "../stores/outcome-store.ts";
import { isCompletedRun, isPopulationRun } from "../program/rollup-shared.ts";

export function latestRunsFromRows(
  rows: readonly OutcomeWithRun[] | (() => readonly OutcomeWithRun[]),
): (measureIds: readonly string[], filter: OutcomeMeasureFilter, perMeasure?: number) => Promise<LatestPopulationRun[]> {
  return async (measureIds, filter, perMeasure = 1) => {
    const source = typeof rows === "function" ? rows() : rows;
    const out: LatestPopulationRun[] = [];
    for (const measureId of new Set(measureIds)) {
      const byRun = new Map<string, OutcomeWithRun>();
      for (const r of source) {
        if (r.measureId !== measureId || !isPopulationRun(r.runScopeType) || !isCompletedRun(r.runStatus)) continue;
        if (filter.excludeScale && r.runTriggeredBy === "seed:scale") continue;
        if (filter.excludeTrendHistory && r.runTriggeredBy === "seed:trend-history") continue;
        const day = r.runStartedAt.slice(0, 10);
        if (filter.from && day < filter.from) continue;
        if (filter.to && day > filter.to) continue;
        if (!byRun.has(r.runId)) byRun.set(r.runId, r);
      }
      const newestFirst = [...byRun.values()]
        .sort((a, b) => b.runStartedAt.localeCompare(a.runStartedAt) || b.runId.localeCompare(a.runId))
        .slice(0, Math.max(1, perMeasure));
      for (const r of newestFirst) {
        out.push({
          measureId, runId: r.runId, runStartedAt: r.runStartedAt,
          runScopeType: r.runScopeType, runStatus: r.runStatus, runTriggeredBy: r.runTriggeredBy,
        });
      }
    }
    return out;
  };
}
