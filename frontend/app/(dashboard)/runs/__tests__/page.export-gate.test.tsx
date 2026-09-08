import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get, post: vi.fn(), downloadBlob: vi.fn() };
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock, useSearchParams: () => searchParamsMock }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({ default: () => <div data-testid="outcomes-grid" /> }));

import RunsPage from "../page";

/** The standards exports are offered only for REPORTABLE runs: FAILED/CANCELLED are terminal, and the
 *  backend refuses them with 409 `run_not_reportable` (ADR-077 d1). Showing the buttons invited a
 *  download that failed, or — before the backend guard — a "complete" report from a fragment. */
function fixtures(status: string) {
  const run = {
    runId: "run-1", measureName: "Breast Cancer Screening", status, scopeType: "MEASURE", triggerType: "MANUAL",
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
}

describe("RunsPage export gate", () => {
  beforeEach(() => fixtures("COMPLETED"));

  it("offers the standards exports for a COMPLETED run", async () => {
    render(<RunsPage />);
    expect(await screen.findByRole("button", { name: "MeasureReport (FHIR)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "QRDA III (XML)" })).toBeInTheDocument();
  });

  it.each(["FAILED", "CANCELLED", "RUNNING"])("hides them for a %s run, which the backend refuses with 409", async (status) => {
    fixtures(status);
    render(<RunsPage />);
    await screen.findByText(/Evaluated:/);
    expect(screen.queryByRole("button", { name: "MeasureReport (FHIR)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QRDA III (XML)" })).not.toBeInTheDocument();
  });
});
