/**
 * When may the monthly quality snapshots be shown as a measure's rate? (#642)
 *
 * `quality_snapshots` rows carry five status counts and no record of which subjects the measure's own
 * logic put OUTSIDE its population. ADR-079 took those subjects out of the denominator everywhere a rate
 * is computed from outcomes, but a snapshot's `denominator` (`total − excluded`) still counts them — so
 * for a measure that produces them, the series understates the rate. On the pilot: cms130 at 17.3%
 * (3,388 / 19,636) under a headline of 41.9% (3,388 / 8,093), cms122 at 4.4% against 47.2%.
 *
 * The trend chart already refused the snapshot series for such a measure, with this reasoning, in
 * `programTrend`. The "Quality over time" panel read `/api/quality/history` directly and went around
 * it. This is the rule both now call, so there is one rule and not two.
 */
import { isOfficialRouted } from "../wiring/official-routing.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { DEPLOYMENT_PROFILE, subjectNoun } from "../config/deployment-profile.ts";

/**
 * The pure rule. `producedOutOfPopulation` is what the ROWS say, not only what today's env says: a
 * routing rollback after official runs were written leaves out-of-population rows under an authored
 * measure, and an env-only check would reopen the series for exactly the measure whose snapshots fold
 * them into `missingData`.
 */
export function snapshotsUnderstateRate(measureId: string, producedOutOfPopulation: boolean): boolean {
  return isOfficialRouted(measureId) || producedOutOfPopulation;
}

/**
 * The same rule for a caller that has not read the rows: the env check first (every pilot measure is
 * routed, so this is the whole answer there), otherwise the latest population run's rows — one run,
 * named from the runs table, never the history.
 *
 * Narrower than `programTrend`'s check, which scans its whole trend window: a measure whose flagged
 * runs are all older than its latest run is not caught here. That needs a routing rollback AND a
 * later run that produced no out-of-population subject, and is recorded rather than read for.
 */
export async function monthlySnapshotsUnderstateRate(
  outcomes: Pick<OutcomeStore, "listLatestPopulationRuns" | "listOutcomesWithRun">,
  measureId: string,
): Promise<boolean> {
  if (isOfficialRouted(measureId)) return true;
  const [winner] = await outcomes.listLatestPopulationRuns([measureId], { excludeScale: true });
  if (!winner) return false;
  const rows = await outcomes.listOutcomesWithRun({ measureId, runIds: [winner.runId], excludeScale: true });
  return snapshotsUnderstateRate(measureId, rows.some((r) => r.outOfPopulation === true));
}

/** What the history route answers instead of a series that would understate the rate. */
export const SNAPSHOT_BASIS_REFUSAL = {
  error: "snapshot_basis_unsafe",
  message:
    `Monthly history is not available for this measure. The older monthly figures counted ${subjectNoun(DEPLOYMENT_PROFILE).plural} ` +
    "the measure does not apply to, so they would show a lower rate than the real one. The trend chart " +
    "on this page shows the correct rate.",
} as const;
