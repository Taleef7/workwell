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
 *
 * #676: a row now records its basis. The materializer leaves out-of-population subjects out of
 * `total` and writes how many it left out (`notInPopulation`, a number); a row written before that
 * has NULL. So the refusal is per ROW, not per measure: a row on the population basis states the rate
 * correctly whatever the measure, and only an old row is withheld.
 */
import type { QualitySnapshotRow } from "../stores/quality-snapshot-store.ts";
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

/** Computed without out-of-population subjects (#676): its denominator is the measure's own. */
export const onPopulationBasis = (row: Pick<QualitySnapshotRow, "notInPopulation">): boolean =>
  row.notInPopulation !== null;

/**
 * The rows a measure's history may serve. For a measure whose snapshots could have counted
 * out-of-population subjects, only rows on the population basis; for any other, every row (an old row
 * of such a measure counted none, so its denominator was already right).
 */
export function servableSnapshots<T extends Pick<QualitySnapshotRow, "notInPopulation">>(
  rows: readonly T[],
  understates: boolean,
): T[] {
  return understates ? rows.filter(onPopulationBasis) : [...rows];
}

/** What the history route answers instead of a series that would understate the rate. */
export const SNAPSHOT_BASIS_REFUSAL = {
  error: "snapshot_basis_unsafe",
  message:
    `Monthly history is not available for this measure. The older monthly figures counted ${subjectNoun(DEPLOYMENT_PROFILE).plural} ` +
    "the measure does not apply to, so they would show a lower rate than the real one. The trend chart " +
    "on this page shows the correct rate.",
} as const;
