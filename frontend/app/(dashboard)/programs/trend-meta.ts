/**
 * UX-8 — derive the /programs card TrendChart's display model from its points. Monthly points
 * (quality_snapshots) carry a `period` (`YYYY-MM`); per-run points don't. Pure + testable so the
 * chart renderer stays a thin view.
 */
export type TrendPoint = {
  runId: string;
  startedAt: string;
  /** `YYYY-MM` for monthly (snapshot) points; absent for per-run points. */
  period?: string;
  complianceRate: number;
  totalEvaluated: number;
};

export interface TrendMeta {
  monthly: boolean;
  chartData: Array<{ label: string; rate: number }>;
  delta: number;
  deltaLabel: string;
  dateHeader: string;
}

/** `data` must already be filtered to points with totalEvaluated > 0 and sorted chronologically. */
export function trendMeta(data: TrendPoint[]): TrendMeta {
  const monthly = data.length > 0 && !!data[0]!.period;
  const chartData = data.map((t) => ({
    label: monthly && t.period
      ? new Date(`${t.period}-01T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "2-digit", timeZone: "UTC" })
      : new Date(t.startedAt).toLocaleDateString("en", { month: "short", day: "numeric" }),
    rate: Math.round(t.complianceRate * 10) / 10,
  }));
  const last = chartData.length ? chartData[chartData.length - 1]!.rate : 0;
  const prev = chartData.length > 1 ? chartData[chartData.length - 2]!.rate : last;
  return {
    monthly,
    chartData,
    delta: last - prev,
    deltaLabel: monthly ? "from last month" : "from last run",
    dateHeader: monthly ? "Month" : "Run date",
  };
}
