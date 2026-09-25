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
    answer([]);
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
    expect(await screen.findByTestId("run-freshness-banner")).toHaveTextContent(/did not finish, so these numbers are from the update of/);
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
