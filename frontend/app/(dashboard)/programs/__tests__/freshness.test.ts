/**
 * #623: what /programs tells the reader when its numbers are not the latest overnight update's.
 */
import { describe, expect, it } from "vitest";
import { freshnessNotice, OVERDUE_AFTER_MS } from "../freshness";

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
