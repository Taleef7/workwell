import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get, getWithHeaders: vi.fn(async (url: string) => ({ data: await get(url), headers: new Headers() })), post: vi.fn(), downloadBlob: vi.fn() };
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
const auth = vi.hoisted(() => ({ role: "ROLE_VIEWER" }));
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock, useSearchParams: () => searchParamsMock }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({ default: () => <div data-testid="outcomes-grid" /> }));

import RunsPage from "../page";

/**
 * Bulk downloads are CASE_MANAGER/ADMIN (D5): the backend answers 403 to anyone else, so the run page
 * does not offer the CSV exports or the standards files to a role that would only meet that 403. The
 * read-only VIEWER (the public sandbox, the Maui clinician seat) still sees the run itself.
 */
const EXPORTS = ["Export runs CSV", "Export outcomes CSV", "MeasureReport (FHIR)", "QRDA III (XML)"];

beforeEach(() => {
  const run = {
    runId: "run-1", measureName: "Breast Cancer Screening", status: "COMPLETED", scopeType: "MEASURE", triggerType: "MANUAL",
    startedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:01:00Z", durationMs: 60_000,
    totalEvaluated: 1, compliantCount: 0, nonCompliantCount: 1,
  };
  const summary = {
    ...run, measureVersion: "1.0", totalCases: 1, passRate: 0, outcomeCounts: [{ status: "OVERDUE", count: 1 }],
    dataFreshAsOf: "2026-08-30T00:01:00Z", dataFreshnessMinutes: 1, retentionNotice: null,
  };
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/runs?limit=20") return Promise.resolve([run]);
    if (url === "/api/runs/run-1") return Promise.resolve(summary);
    return Promise.resolve([]);
  });
});

describe("RunsPage bulk downloads by role", () => {
  it("offers no bulk download to a VIEWER, who still sees the run", async () => {
    auth.role = "ROLE_VIEWER";
    render(<RunsPage />);
    await screen.findByText(/Evaluated:/);
    for (const name of EXPORTS) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it.each(["ROLE_CASE_MANAGER", "ROLE_ADMIN"])("offers every one to %s", async (role) => {
    auth.role = role;
    render(<RunsPage />);
    expect(await screen.findByRole("button", { name: "MeasureReport (FHIR)" })).toBeInTheDocument();
    for (const name of EXPORTS) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });
});
