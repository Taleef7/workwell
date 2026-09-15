/**
 * The tag rule, tested where it can actually be tested.
 *
 * The measure page's panels each land on their own now, which re-opens the race that gating the first
 * paint on `Promise.allSettled` was accidentally closing: measure A's slow response painting under
 * measure B's heading. The guard against it is that every value carries the measure it describes.
 *
 * This is a PURE unit test on purpose. The jsdom `next/navigation` mock updates `useParams`
 * synchronously, so a mounted component cannot reproduce a router race at all — the standing rule
 * from 2026-09-12 about that harness. What a mount CAN show is the paint behaviour, and those
 * assertions live in `page.slices.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { applySlice, beginLoad, freshSlices, previousTrendPoint, type RiskOutlook } from "../measure-slices";

type Point = { runId: string; startedAt: string; complianceRate: number };

const point = (runId: string, complianceRate: number): Point => ({ runId, startedAt: "2026-09-01T00:00:00Z", complianceRate });

const outlook: RiskOutlook = {
  upcomingNonCompliantCount: 3,
  upcomingExpirations: [],
  repeatNonCompliers: [],
  siteComplianceRates: [{ site: "Plant A", total: 10, compliant: 5, upcomingExpirations: 1, currentComplianceRate: 50, predictedComplianceRate: 40 }],
};

describe("freshSlices", () => {
  it("starts every panel loading, so no panel asserts an empty result before it has read anything", () => {
    const s = freshSlices<Point>("cms125");
    expect(s.measureId).toBe("cms125");
    expect(s.status).toEqual({ program: "loading", trend: "loading", drivers: "loading", outlook: "loading" });
    expect(s.program).toBeNull();
    expect(s.trend).toEqual([]);
    expect(s.drivers).toEqual({ bySite: [], byRole: [], byOutcomeReason: [] });
    expect(s.outlook).toBeNull();
  });
});

describe("applySlice — the tag rule", () => {
  it("applies an update for the measure it describes", () => {
    const next = applySlice(freshSlices<Point>("cms125"), { measureId: "cms125", loadId: 0, key: "outlook", value: outlook });
    expect(next.outlook).toBe(outlook);
    expect(next.status.outlook).toBe("ready");
  });

  it("DROPS an update for another measure, returning the identical object", () => {
    const before = freshSlices<Point>("cms125");
    const after = applySlice(before, { measureId: "cms122", loadId: 0, key: "outlook", value: outlook });
    // Reference equality, not just deep equality: a stale response must not even re-render.
    expect(after).toBe(before);
    expect(after.outlook).toBeNull();
    expect(after.status.outlook).toBe("loading");
  });

  it("drops a stale FAILURE too — a slow A rejecting after B mounted must not mark B unavailable", () => {
    const before = applySlice(freshSlices<Point>("cms125"), { measureId: "cms125", loadId: 0, key: "outlook", value: outlook });
    const after = applySlice(before, { measureId: "cms122", loadId: 0, key: "outlook", failed: true });
    expect(after).toBe(before);
    expect(after.status.outlook).toBe("ready");
  });

  it("keeps the other panels untouched when one lands", () => {
    let s = freshSlices<Point>("cms125");
    s = applySlice(s, { measureId: "cms125", loadId: 0, key: "trend", value: [point("run-1", 50)] });
    expect(s.status).toEqual({ program: "loading", trend: "ready", drivers: "loading", outlook: "loading" });
    s = applySlice(s, { measureId: "cms125", loadId: 0, key: "drivers", failed: true });
    expect(s.status).toEqual({ program: "loading", trend: "ready", drivers: "failed", outlook: "loading" });
    expect(s.trend).toHaveLength(1);
  });

  it("a failure keeps the value already on screen and only moves the status", () => {
    let s = applySlice(freshSlices<Point>("cms125"), { measureId: "cms125", loadId: 0, key: "outlook", value: outlook });
    s = applySlice(s, { measureId: "cms125", loadId: 0, key: "outlook", failed: true });
    // This is what makes a run-complete refresh non-destructive: the numbers stay until new ones land.
    expect(s.outlook).toBe(outlook);
    expect(s.status.outlook).toBe("failed");
  });

  it("two panels completing together cannot overwrite each other", () => {
    const start = freshSlices<Point>("cms125");
    const both = applySlice(
      applySlice(start, { measureId: "cms125", loadId: 0, key: "trend", value: [point("run-1", 50)] }),
      { measureId: "cms125", loadId: 0, key: "outlook", value: outlook },
    );
    expect(both.trend).toHaveLength(1);
    expect(both.outlook).toBe(outlook);
    expect(both.status.trend).toBe("ready");
    expect(both.status.outlook).toBe("ready");
  });
});

describe("beginLoad + loadId — two loads of the SAME measure", () => {
  it("drops the OLDER load's response when a refresh has already started", () => {
    // Raised independently by two reviewers against the measure-tag-only version. A
    // `ww:run-complete` refresh begins while the first read is still in flight; if the first
    // response is then applied, the page shows the PREVIOUS run's numbers after the new run landed.
    const first = freshSlices<Point>("cms125", 1);
    const refreshed = beginLoad(first, "cms125", 2);
    const stale = applySlice(refreshed, { measureId: "cms125", loadId: 1, key: "trend", value: [point("old", 10)] });
    expect(stale).toBe(refreshed);
    const fresh = applySlice(refreshed, { measureId: "cms125", loadId: 2, key: "trend", value: [point("new", 90)] });
    expect(fresh.trend).toEqual([point("new", 90)]);
  });

  it("a REFRESH keeps the values and statuses already on screen, and only moves the generation", () => {
    const ready = applySlice(freshSlices<Point>("cms125", 1), { measureId: "cms125", loadId: 1, key: "outlook", value: outlook });
    const refreshed = beginLoad(ready, "cms125", 2);
    expect(refreshed.outlook).toBe(outlook);
    expect(refreshed.status.outlook).toBe("ready");
    expect(refreshed.loadId).toBe(2);
  });

  it("a NAVIGATION resets every panel to its skeleton", () => {
    const ready = applySlice(freshSlices<Point>("cms125", 1), { measureId: "cms125", loadId: 1, key: "outlook", value: outlook });
    const navigated = beginLoad(ready, "cms122", 2);
    expect(navigated.measureId).toBe("cms122");
    expect(navigated.outlook).toBeNull();
    expect(navigated.status.outlook).toBe("loading");
  });

  it("re-beginning the SAME load is identity, so it cannot cause a re-render", () => {
    const s = freshSlices<Point>("cms125", 3);
    expect(beginLoad(s, "cms125", 3)).toBe(s);
  });
});

describe("previousTrendPoint", () => {
  it("is null while the trend is still loading, so no delta flashes in", () => {
    const s = freshSlices<Point>("cms125");
    s.trend = [point("run-1", 50), point("run-0", 40)];
    expect(previousTrendPoint(s)).toBeNull();
  });

  it("is null for a one-point history — the case that produced a false '0.0 from previous'", () => {
    const s = applySlice(freshSlices<Point>("cms125"), { measureId: "cms125", loadId: 0, key: "trend", value: [point("run-1", 50)] });
    expect(previousTrendPoint(s)).toBeNull();
  });

  it("is null for an empty history", () => {
    const s = applySlice(freshSlices<Point>("cms125"), { measureId: "cms125", loadId: 0, key: "trend", value: [] });
    expect(previousTrendPoint(s)).toBeNull();
  });

  it("is the SECOND point once the trend is ready with two", () => {
    const s = applySlice(freshSlices<Point>("cms125"), {
      measureId: "cms125",
      loadId: 0,
      key: "trend",
      value: [point("run-1", 50), point("run-0", 40)],
    });
    expect(previousTrendPoint(s)).toEqual(point("run-0", 40));
  });
});
