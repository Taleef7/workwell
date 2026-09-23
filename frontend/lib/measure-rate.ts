export interface RateCounts {
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  /** The backend's workflow rate; null when nobody is counted yet (#637). */
  complianceRate: number | null;
}

export interface TrendPoint extends RateCounts {
  runId: string;
  startedAt: string;
  /** `YYYY-MM` for monthly (snapshot) points; absent for per-run points. */
  period?: string;
  totalEvaluated: number;
  denominator?: number;
  /** The year the point's run scored (#637); points are compared within one year only. */
  measurementYear?: number;
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
  /** null when nobody is counted yet: "no data", never 0% (#637). */
  value: number | null;
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
    const value = denominator === 0 ? null : Math.round((counts.overdue / denominator) * 1000) / 10;
    return { label: "Poor control", value, lowerIsBetter: true, numerator: counts.overdue, denominator };
  }
  const denominator = counts.compliant + counts.dueSoon + counts.overdue + counts.missingData;
  return { label: "Compliance", value: denominator === 0 ? null : counts.complianceRate, lowerIsBetter: false, numerator: counts.compliant, denominator };
}

/**
 * Below this many patients a rate is shown with a "based on N patients so far" note (#637). 20 is
 * CMS's case minimum for scoring a MIPS quality measure — the same point at which CMS itself stops
 * treating a rate as meaningful. Early in a measurement year every measure starts under it.
 */
export const SMALL_NUMBERS_BELOW = 20;

export function isSmallNumbers(rate: Pick<DisplayRate, "denominator">): boolean {
  return rate.denominator > 0 && rate.denominator < SMALL_NUMBERS_BELOW;
}

/** A rate for display: `—` when there is none (#637). */
export function formatRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}
