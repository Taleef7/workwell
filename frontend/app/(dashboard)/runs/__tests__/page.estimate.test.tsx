/**
 * The run detail shows two rates (compliant of everyone evaluated, and the CMS measure rate in the
 * reconciliation). On the patient deployment it says beside them that they are WorkWell's estimate,
 * naming CMS's FHIR logic only for a run whose reconciliation shows official evidence (the page lists
 * authored runs from before the routing flip too); on the occupational deployment it says nothing.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

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

const run = {
  runId: "run-1", measureName: "Breast Cancer Screening", status: "COMPLETED", scopeType: "MEASURE", triggerType: "MANUAL",
  startedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:01:00Z", durationMs: 60_000,
  totalEvaluated: 4, compliantCount: 1, nonCompliantCount: 3,
};
const summary = {
  ...run, measureVersion: "1.0", totalCases: 1, passRate: 25, outcomeCounts: [{ status: "OVERDUE", count: 1 }],
  dataFreshAsOf: "2026-08-30T00:01:00Z", dataFreshnessMinutes: 1, retentionNotice: null,
};

const ESTIMATE = "WorkWell's estimate from CMS's FHIR logic. WebChart calculates and submits the reported rate.";
const ESTIMATE_ANY_ENGINE = "WorkWell's estimate. WebChart calculates and submits the reported rate.";

const reconciliation = (official: unknown) => ({
  runId: "run-1", status: "COMPLETED", unit: "subject-measure pairs", workItems: 4, rowsPersisted: 4,
  byStatus: [{ status: "OVERDUE", count: 1 }], evaluationErrors: 0, official,
  casesCiting: 1, compaction: { exposed: false, cutoff: null }, notes: [],
});
const OFFICIAL = {
  measureId: "cms125",
  rates: [{ label: null, ipp: 2, denom: 2, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }],
  outOfPopulation: 0, unmeasured: 0, evaluationErrors: 0,
};

function mockRun(official: unknown) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/runs?limit=20") return Promise.resolve([run]);
    if (url === "/api/runs/run-1") return Promise.resolve(summary);
    if (url === "/api/runs/run-1/reconciliation") return Promise.resolve(reconciliation(official));
    return Promise.resolve([]);
  });
}

beforeEach(() => mockRun(null));

describe("RunsPage estimate caveat", () => {
  it("names CMS's FHIR logic for a run whose evidence is official, on the patient deployment", async () => {
    setSubject("patient");
    mockRun(OFFICIAL);
    render(<RunsPage />);
    await screen.findByTestId("run-reconciliation");
    expect(screen.getByText(ESTIMATE)).toBeInTheDocument();
  });

  it("credits WorkWell's translation, not CMS's logic, for a run a translation scored", async () => {
    setSubject("patient");
    mockRun({ ...OFFICIAL, logic: { kind: "workwell-translation", label: "WorkWell translation of CMS125v15" } });
    render(<RunsPage />);
    await screen.findByTestId("run-reconciliation");
    expect(screen.getByText("WorkWell's estimate from its own translation of CMS's logic. WebChart calculates and submits the reported rate.")).toBeInTheDocument();
    expect(screen.queryByText(ESTIMATE)).toBeNull();
  });

  it("claims no engine for an authored run (no official evidence), and still calls the rate an estimate", async () => {
    setSubject("patient");
    render(<RunsPage />);
    await screen.findByTestId("run-reconciliation");
    expect(screen.getByText(ESTIMATE_ANY_ENGINE)).toBeInTheDocument();
    expect(screen.queryByText(ESTIMATE)).toBeNull();
  });

  it("says nothing of the kind on the occupational deployment", async () => {
    setSubject("employee");
    render(<RunsPage />);
    await screen.findByText(/Compliant: 25\.0% of everyone evaluated/);
    expect(screen.queryByText(ESTIMATE)).toBeNull();
    expect(screen.queryByText(ESTIMATE_ANY_ENGINE)).toBeNull();
  });
});
