import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get, getWithHeaders: vi.fn(async (url: string) => ({ data: await get(url), headers: new Headers() })), post: vi.fn(), downloadBlob: vi.fn() };
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock, useSearchParams: () => searchParamsMock }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({ default: () => <div data-testid="outcomes-grid" /> }));

import RunsPage from "../page";

/**
 * #853 (D12): a run whose live data was too thin to trust says so above its counts, and offers no export
 * the server would refuse with 409 `data_insufficient`.
 */
function fixtures(dataInsufficient?: unknown) {
  const run = {
    runId: "run-1", measureName: "Controlling High Blood Pressure", status: dataInsufficient ? "PARTIAL_FAILURE" : "COMPLETED",
    scopeType: "MEASURE", triggerType: "MANUAL",
    startedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:01:00Z", durationMs: 60_000,
    totalEvaluated: 2, compliantCount: 0, nonCompliantCount: 2,
  };
  const summary = {
    ...run, measureVersion: "1.0", totalCases: 0, passRate: 0, outcomeCounts: [{ status: "MISSING_DATA", count: 2 }],
    dataFreshAsOf: "2026-08-30T00:01:00Z", dataFreshnessMinutes: 1, retentionNotice: null,
  };
  const reconciliation = {
    runId: "run-1", status: run.status, unit: "subject-measure pairs", workItems: 2, rowsPersisted: 2,
    byStatus: [{ status: "MISSING_DATA", count: 2 }], evaluationErrors: 0, official: null, casesCiting: 0,
    compaction: { exposed: false, cutoff: null }, notes: [],
    ...(dataInsufficient ? { dataInsufficient } : {}),
  };
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/runs?limit=20") return Promise.resolve([run]);
    if (url === "/api/runs/run-1") return Promise.resolve(summary);
    if (url === "/api/runs/run-1/reconciliation") return Promise.resolve(reconciliation);
    return Promise.resolve([]);
  });
}

describe("RunsPage data sufficiency", () => {
  beforeEach(() => fixtures());

  it("names each thin measure and what fell short, and hides the exports", async () => {
    fixtures([
      {
        measureId: "cms165",
        shortfalls: [
          { check: "encounterTypeCoded", observed: 0, floor: 0.95, count: 0, of: 89 },
          { check: "bloodPressureFinal", observed: 0, floor: 0.95, count: 0, of: 12 },
        ],
      },
    ]);
    render(<RunsPage />);
    const banner = await screen.findByTestId("run-data-insufficient");
    expect(banner).toHaveTextContent("Data too thin to trust");
    expect(banner).toHaveTextContent("cms165: encounter types coded: 0 of 89 (0.0%), floor 95.0%; blood pressures final: 0 of 12 (0.0%), floor 95.0%");
    expect(screen.queryByRole("button", { name: "MeasureReport (FHIR)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QRDA III (XML)" })).not.toBeInTheDocument();
    // On a single-measure run the pooled line IS that measure's rate.
    expect(screen.queryByTestId("run-pass-rate")).not.toBeInTheDocument();
  });

  it("still names a thin measure, rate and exports withheld, when the run's record of the shortfall is gone", async () => {
    fixtures([{ measureId: "cms165", shortfalls: [] }]);
    render(<RunsPage />);
    const banner = await screen.findByTestId("run-data-insufficient");
    expect(banner).toHaveTextContent("cms165: the record of which check fell short was not kept");
    expect(screen.queryByTestId("run-pass-rate")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "MeasureReport (FHIR)" })).not.toBeInTheDocument();
  });

  it("shows no banner and keeps the exports for a run whose data met its floors", async () => {
    render(<RunsPage />);
    expect(await screen.findByRole("button", { name: "MeasureReport (FHIR)" })).toBeInTheDocument();
    expect(screen.queryByTestId("run-data-insufficient")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-pass-rate")).toHaveTextContent("Compliant: 0.0% of everyone evaluated");
  });
});
