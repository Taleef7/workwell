/**
 * #623: /programs says when its numbers are not the latest overnight update's.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

import ProgramsPage from "../page";

function answer(runs: unknown[] | Error) {
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/runs?")) return runs instanceof Error ? Promise.reject(runs) : Promise.resolve(runs);
    return Promise.resolve([]);
  });
}

beforeEach(() => setSubject("patient"));

describe("ProgramsPage says when its numbers are stale (#623)", () => {
  it("asks only for whole-practice runs", async () => {
    answer([{ status: "COMPLETED", startedAt: new Date().toISOString() }]);
    render(<ProgramsPage />);
    await screen.findByText("Programs Overview");
    expect(get.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/runs?"))).toEqual(["/api/runs?scopeType=ALL_PROGRAMS&limit=5"]);
  });

  it("warns when the latest overnight update failed, and names the update shown", async () => {
    answer([
      { status: "FAILED", startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
      { status: "COMPLETED", startedAt: new Date(Date.now() - 26 * 3600_000).toISOString() },
    ]);
    render(<ProgramsPage />);
    expect(await screen.findByTestId("run-freshness-banner")).toHaveTextContent(/did not finish, so the numbers below are from earlier updates\. The last complete update of every measure started/);
  });

  it("stays quiet when the latest update completed, and when the read fails", async () => {
    answer([{ status: "COMPLETED", startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }]);
    const { unmount } = render(<ProgramsPage />);
    await screen.findByText("Programs Overview");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("run-freshness-banner")).toBeNull();
    unmount();

    answer(new Error("network"));
    render(<ProgramsPage />);
    await screen.findByText("Programs Overview");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("run-freshness-banner")).toBeNull();
  });
});

describe("the banner judges a missing update against the deployment's schedule", () => {
  // An update 50 hours old: past the daily rule's 36, but on a deployment whose next scheduled nightly
  // is two days from now (a weekend on a weekdays-only schedule), nothing has been missed yet.
  const started = new Date(Date.now() - 50 * 3600_000).toISOString();
  const onlyTheDayAfterTomorrow = [new Date(Date.now() + 2 * 86_400_000).getUTCDay()];
  const serve = (schedule: unknown) =>
    get.mockReset().mockImplementation((url: string) => {
      if (url.startsWith("/api/runs?")) return Promise.resolve([{ status: "COMPLETED", startedAt: started }]);
      if (url === "/api/runs/schedule") return schedule instanceof Error ? Promise.reject(schedule) : Promise.resolve(schedule);
      return Promise.resolve([]);
    });

  it("stays quiet when the schedule has no nightly due yet", async () => {
    serve({ enabled: true, anchorHourUtc: 12, days: onlyTheDayAfterTomorrow });
    render(<ProgramsPage />);
    await screen.findByText("Programs Overview");
    await new Promise((r) => setTimeout(r, 0));
    expect(get.mock.calls.map(([u]) => String(u))).toContain("/api/runs/schedule");
    expect(screen.queryByTestId("run-freshness-banner")).toBeNull();
  });

  it("falls back to the daily rule when the schedule cannot be read", async () => {
    serve(new Error("older server"));
    render(<ProgramsPage />);
    expect(await screen.findByTestId("run-freshness-banner")).toBeInTheDocument();
  });
});
