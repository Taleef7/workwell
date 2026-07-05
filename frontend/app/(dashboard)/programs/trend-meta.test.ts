import { describe, it, expect } from "vitest";
import { trendMeta, type TrendPoint } from "./trend-meta";

const p = (over: Partial<TrendPoint>): TrendPoint => ({ runId: "r", startedAt: "2026-06-15T00:00:00Z", complianceRate: 80, totalEvaluated: 10, ...over });

describe("trendMeta", () => {
  it("monthly (period present) → month/year labels, 'from last month', 'Month' header", () => {
    const m = trendMeta([
      p({ period: "2026-05", complianceRate: 90, startedAt: "2026-05-28T00:00:00Z" }),
      p({ period: "2026-06", complianceRate: 80, startedAt: "2026-06-28T00:00:00Z" }),
    ]);
    expect(m.monthly).toBe(true);
    expect(m.deltaLabel).toBe("from last month");
    expect(m.dateHeader).toBe("Month");
    expect(m.chartData[0]!.label).toMatch(/May/);
    expect(m.chartData[1]!.rate).toBe(80);
    expect(m.delta).toBeCloseTo(-10, 1); // 80 - 90
  });

  it("per-run (no period) → day labels, 'from last run', 'Run date' header", () => {
    const m = trendMeta([
      p({ complianceRate: 70, startedAt: "2026-06-01T00:00:00Z" }),
      p({ complianceRate: 78, startedAt: "2026-06-08T00:00:00Z" }),
    ]);
    expect(m.monthly).toBe(false);
    expect(m.deltaLabel).toBe("from last run");
    expect(m.dateHeader).toBe("Run date");
    expect(m.delta).toBeCloseTo(8, 1);
  });
});
