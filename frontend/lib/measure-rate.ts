import type { MeasureIdentity } from "./measure-identity";

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

export interface DisplayRate {
  label: "Compliance" | "Poor control";
  value: number;
  lowerIsBetter: boolean;
}

export function displayRate(counts: RateCounts, identity: MeasureIdentity | null | undefined): DisplayRate {
  if (identity?.improvementNotation === "decrease") {
    const denominator = counts.compliant + counts.dueSoon + counts.overdue;
    const value = denominator === 0 ? 0 : Math.round((counts.overdue / denominator) * 1000) / 10;
    return { label: "Poor control", value, lowerIsBetter: true };
  }
  return { label: "Compliance", value: counts.complianceRate, lowerIsBetter: false };
}
