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
   * The denominator the displayed percentage was divided by. For increase measures this is
   * total − excluded (compliant + dueSoon + overdue + missingData — the same four-bucket sum the
   * backend's `complianceRateOf` divides by, so `value` and this pair always agree). For decrease
   * measures MISSING_DATA is outside the initial population on the official path, so it is
   * compliant + dueSoon + overdue.
   */
  denominator: number;
}

export function displayRate(counts: RateCounts, notation: NotationSource | null | undefined): DisplayRate {
  if (notation?.improvementNotation === "decrease") {
    const denominator = counts.compliant + counts.dueSoon + counts.overdue;
    const value = denominator === 0 ? 0 : Math.round((counts.overdue / denominator) * 1000) / 10;
    return { label: "Poor control", value, lowerIsBetter: true, numerator: counts.overdue, denominator };
  }
  const denominator = counts.compliant + counts.dueSoon + counts.overdue + counts.missingData;
  return { label: "Compliance", value: counts.complianceRate, lowerIsBetter: false, numerator: counts.compliant, denominator };
}
