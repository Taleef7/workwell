import React from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

import ProgramsPage from "../page";

/** The programs overview shows TWO rates and never confuses them: the workflow-status percentage (the
 *  five buckets) and, when the run carries official evidence, the measure's own rate as the
 *  MeasureReport would report it (ADR-077 d5). */
const base = {
  measureId: "cms137",
  measureName: "Initiation and Engagement of Substance Use Disorder Treatment",
  policyRef: "CMS137",
  version: "FHIR v1",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 10,
  denominator: 10,
  compliant: 4,
  dueSoon: 0,
  overdue: 6,
  missingData: 0,
  excluded: 0,
  complianceRate: 40,
  openCaseCount: 6,
};
const withRate = {
  ...base,
  measureRate: {
    source: "official-evidence",
    runId: "run-1",
    official: { ecqmId: "CMS137FHIR", version: "1.0.000" },
    rates: [
      { label: "Initiation", ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 4, effectiveDenominator: 10, score: 0.4 },
      { label: "Engagement", ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 10, score: 0.1 },
    ],
    unmeasured: 2,
    evaluationErrors: 2,
  },
};
const withoutRate = { ...base, measureId: "audiogram", measureName: "Audiogram", policyRef: "OSHA", measureRate: null };

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([withRate, withoutRate]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    return Promise.resolve([]);
  });
});

describe("ProgramsPage measure rate", () => {
  it("shows the evidence's rate per rate, labelled as official evidence, beside the workflow-status rate", async () => {
    render(<ProgramsPage />);
    const tile = await screen.findByTestId("measure-rate-cms137");
    expect(within(tile).getByText("Measure rate (official evidence)")).toBeInTheDocument();
    expect(within(tile).getByText(/Initiation/)).toHaveTextContent("Initiation: 40.0%");
    expect(within(tile).getByText(/Engagement/)).toHaveTextContent("Engagement: 10.0%");
    expect(within(tile).getByText("2 evaluation errors not counted")).toBeInTheDocument();
    expect(screen.getAllByText("Workflow status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Workflow status trend").length).toBeGreaterThan(0);
  });

  it("shows no measure-rate tile for a run without official evidence", async () => {
    render(<ProgramsPage />);
    await screen.findByTestId("measure-rate-cms137");
    expect(screen.queryByTestId("measure-rate-audiogram")).not.toBeInTheDocument();
  });
});
