/**
 * UX-8 — derive the /programs card TrendChart's display model from its points. Monthly points
 * (quality_snapshots) carry a `period` (`YYYY-MM`); per-run points don't. Pure + testable so the
 * chart renderer stays a thin view.
 */
import { displayRate, type NotationSource, type TrendPoint } from "@/lib/measure-rate";

export type { TrendPoint };

export interface TrendMeta {
  monthly: boolean;
  chartData: Array<{ label: string; rate: number }>;
  delta: number;
  deltaLabel: string;
  dateHeader: string;
}

/**
 * The points a trend line may draw (#637): completed points with a rate, oldest first, and only those
 * from the SAME measurement year as the newest point. Comparing a new year's first run with last
 * year's final one is not a change over time — it read as "↓ 72% from last run" on 1 January.
 * A point without a year (an older server) is kept.
 */
export function chartablePoints(data: TrendPoint[], notation?: NotationSource | null): TrendPoint[] {
  const sorted = [...(data ?? [])]
    .filter((t) => t.totalEvaluated > 0 && displayRate(t, notation).value !== null)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  const year = sorted.at(-1)?.measurementYear;
  return year === undefined ? sorted : sorted.filter((t) => t.measurementYear === undefined || t.measurementYear === year);
}

/** `data` must already be `chartablePoints(...)`. */
export function trendMeta(data: TrendPoint[], notation?: NotationSource | null): TrendMeta {
  const monthly = data.length > 0 && !!data[0]!.period;
  const chartData = data.map((t) => ({
    label: monthly && t.period
      ? new Date(`${t.period}-01T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "2-digit", timeZone: "UTC" })
      : new Date(t.startedAt).toLocaleDateString("en", { month: "short", day: "numeric" }),
    rate: (notation ? displayRate(t, notation).value : t.complianceRate === null ? null : Math.round(t.complianceRate * 10) / 10) ?? 0,
  }));
  const last = chartData.length ? chartData[chartData.length - 1]!.rate : 0;
  const prev = chartData.length > 1 ? chartData[chartData.length - 2]!.rate : last;
  return {
    monthly,
    chartData,
    delta: Math.round((last - prev) * 10) / 10,
    deltaLabel: monthly ? "from last month" : "from last run",
    dateHeader: monthly ? "Month" : "Run date",
  };
}
