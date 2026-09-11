export interface RateCounts {
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  complianceRate: number;
}

export interface TrendPoint extends RateCounts {
  runId: string;
  startedAt: string;
  /** `YYYY-MM` for monthly (snapshot) points; absent for per-run points. */
  period?: string;
  totalEvaluated: number;
  denominator?: number;
}

/**
 * Anything that says which way the measure improves: a `MeasureIdentity` from `/api/measures`, or
 * the program summary itself (the overview API carries `improvementNotation` so the rate never
 * depends on a second request resolving). Absent means increase.
 */
export interface NotationSource {
  improvementNotation?: "increase" | "decrease";
}

export interface DisplayRate {
  label: "Compliance" | "Poor control";
  value: number;
  lowerIsBetter: boolean;
  /** The count the displayed percentage is made of: compliant for increase, overdue for decrease. */
  numerator: number;
  /**
   * The denominator the displayed percentage was divided by: compliant + dueSoon + overdue +
   * missingData — the same four-bucket sum the backend's `complianceRateOf` divides by, so `value`
   * and this pair always agree.
   *
   * The decrease branch used to drop `missingData` here, on the grounds that on the official path
   * those subjects were outside the initial population. That was a workaround for a BACKEND defect,
   * and since ADR-079 the backend reports the split itself: `missingData` now holds only subjects who
   * ARE in the population and whose result is missing. Keeping the workaround would drop real work
   * from the denominator — 20 compliant / 20 overdue / 20 in-population missing would render Poor
   * control at 50.0% where the honest figure is 33.3%.
   */
  denominator: number;
}

export function displayRate(counts: RateCounts, notation: NotationSource | null | undefined): DisplayRate {
  if (notation?.improvementNotation === "decrease") {
    const denominator = counts.compliant + counts.dueSoon + counts.overdue + counts.missingData;
    const value = denominator === 0 ? 0 : Math.round((counts.overdue / denominator) * 1000) / 10;
    return { label: "Poor control", value, lowerIsBetter: true, numerator: counts.overdue, denominator };
  }
  const denominator = counts.compliant + counts.dueSoon + counts.overdue + counts.missingData;
  return { label: "Compliance", value: counts.complianceRate, lowerIsBetter: false, numerator: counts.compliant, denominator };
}
