/**
 * #623: what /programs tells the reader when its numbers are not the latest overnight update's.
 */
import { describe, expect, it } from "vitest";
import { freshnessNotice, nextScheduledAfter, OVERDUE_AFTER_MS } from "../freshness";

const NOW = Date.parse("2026-09-25T14:00:00Z");
const run = (status: string, startedAt: string) => ({ status, startedAt });

describe("freshnessNotice (#623)", () => {
  it("says nothing when the newest update completed within a cycle", () => {
    expect(freshnessNotice([run("COMPLETED", "2026-09-25T12:08:00Z")], NOW)).toBeNull();
  });

  it("says nothing while an update is in progress: the run indicator already does", () => {
    for (const s of ["RUNNING", "queued", "REQUESTED"]) {
      expect(freshnessNotice([run(s, "2026-09-25T12:08:00Z"), run("FAILED", "2026-09-24T12:08:00Z")], NOW)).toBeNull();
    }
  });

  it("an update 'in progress' for longer than a cycle is stuck, and the numbers are stale", () => {
    const stuck = new Date(NOW - OVERDUE_AFTER_MS - 60_000).toISOString();
    expect(freshnessNotice([run("RUNNING", stuck)], NOW)).toEqual({ kind: "overdue", latestAt: stuck });
  });

  it("a failed update names the update whose numbers are shown", () => {
    expect(freshnessNotice([run("FAILED", "2026-09-25T12:08:00Z"), run("CANCELLED", "2026-09-24T12:08:00Z"), run("COMPLETED", "2026-09-23T12:08:00Z")], NOW)).toEqual({
      kind: "failed",
      latestAt: "2026-09-25T12:08:00Z",
      dataFromAt: "2026-09-23T12:08:00Z",
    });
  });

  it("a PARTIAL_FAILURE counts as the shown update, since the dashboard reports it", () => {
    expect(freshnessNotice([run("FAILED", "2026-09-25T12:08:00Z"), run("PARTIAL_FAILURE", "2026-09-24T12:08:00Z")], NOW)).toMatchObject({ dataFromAt: "2026-09-24T12:08:00Z" });
    expect(freshnessNotice([run("partial_failure", "2026-09-25T12:08:00Z")], NOW)).toEqual({ kind: "partial", latestAt: "2026-09-25T12:08:00Z" });
  });

  it("a failed update with no finished one listed says so, rather than naming none", () => {
    expect(freshnessNotice([run("FAILED", "2026-09-25T12:08:00Z")], NOW)).toMatchObject({ kind: "failed", dataFromAt: null });
  });

  it("an update older than a nightly cycle allows is overdue", () => {
    const old = new Date(NOW - OVERDUE_AFTER_MS - 60_000).toISOString();
    expect(freshnessNotice([run("COMPLETED", old)], NOW)).toEqual({ kind: "overdue", latestAt: old });
    const recent = new Date(NOW - OVERDUE_AFTER_MS + 60_000).toISOString();
    expect(freshnessNotice([run("COMPLETED", recent)], NOW)).toBeNull();
  });

  it("no whole-practice run at all says so, rather than staying silent forever (#710, Codex)", () => {
    expect(freshnessNotice([], NOW)).toEqual({ kind: "none" });
  });
});

// Weekdays only (Maui since 2026-09-30): Friday's nightly is followed by Monday's, so the weekend is
// not a missed update. 2026-10-02 is a Friday; the anchor is 12:00 UTC.
describe("freshnessNotice against a weekdays-only schedule", () => {
  const WEEKDAYS = { anchorHourUtc: 12, days: [1, 2, 3, 4, 5] };
  const friday = [run("COMPLETED", "2026-10-02T12:05:00Z")];

  it("the next scheduled nightly after Friday's is Monday's", () => {
    expect(new Date(nextScheduledAfter(Date.parse("2026-10-02T12:05:00Z"), WEEKDAYS)).toISOString()).toBe("2026-10-05T12:00:00.000Z");
    // A run shortly before the hour counts as that day's, so the next is the following weekday's.
    expect(new Date(nextScheduledAfter(Date.parse("2026-10-06T11:50:00Z"), WEEKDAYS)).toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });

  it("says nothing over the weekend, where the daily rule would have warned from Friday night", () => {
    for (const at of ["2026-10-03T01:00:00Z", "2026-10-04T20:00:00Z", "2026-10-05T11:00:00Z", "2026-10-05T23:59:00Z"]) {
      expect(freshnessNotice(friday, Date.parse(at), WEEKDAYS)).toBeNull();
      if (at !== "2026-10-03T01:00:00Z") expect(freshnessNotice(friday, Date.parse(at))).toMatchObject({ kind: "overdue" });
    }
  });

  it("warns once Monday's nightly is 12 hours late", () => {
    expect(freshnessNotice(friday, Date.parse("2026-10-06T00:01:00Z"), WEEKDAYS)).toEqual({ kind: "overdue", latestAt: "2026-10-02T12:05:00Z" });
  });

  it("a weekday miss is caught as fast as before", () => {
    const tuesday = [run("COMPLETED", "2026-10-06T12:05:00Z")];
    expect(freshnessNotice(tuesday, Date.parse("2026-10-07T23:00:00Z"), WEEKDAYS)).toBeNull();
    expect(freshnessNotice(tuesday, Date.parse("2026-10-08T00:01:00Z"), WEEKDAYS)).toMatchObject({ kind: "overdue" });
  });

  it("a run stuck in progress keeps the daily rule, and an every-day schedule is the daily rule", () => {
    expect(freshnessNotice([run("RUNNING", "2026-10-02T12:05:00Z")], Date.parse("2026-10-04T01:00:00Z"), WEEKDAYS)).toMatchObject({ kind: "overdue" });
    expect(freshnessNotice(friday, Date.parse("2026-10-04T01:00:00Z"), { anchorHourUtc: 12, days: null })).toMatchObject({ kind: "overdue" });
  });
});
