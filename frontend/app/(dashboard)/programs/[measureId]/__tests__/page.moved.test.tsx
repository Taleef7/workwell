/**
 * What moved from the programs card to the measure page (#637): the CMS measure rate and the
 * staff-closed reconciliation link — and what the measure page no longer shows.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import ProgramDetailPage from "../page";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useParams: () => ({ measureId: "cms137" }) }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

const base = {
  measureId: "cms137",
  measureName: "Substance use treatment",
  policyRef: "CMS137",
  version: "v1.0",
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
  staffClosedGapCount: 4,
  measureRate: {
    rates: [
      { label: "Initiation", ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 4, effectiveDenominator: 10, score: 0.4 },
      { label: "Engagement", ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 10, score: 0.1 },
    ],
    unmeasured: 2,
    evaluationErrors: 2,
  },
};

function mockPrograms(program: unknown) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve([program]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    if (url.includes("/risk-outlook")) return Promise.resolve(null);
    return Promise.resolve([]);
  });
}

beforeEach(() => setSubject("patient"));

describe("ProgramDetailPage — what moved here from the card (#637)", () => {
  it("shows the CMS measure rate per rate, with evaluation errors, and says how it differs", async () => {
    mockPrograms(withRate);
    render(<ProgramDetailPage />);
    const tile = await screen.findByTestId("measure-rate-cms137");
    expect(within(tile).getByText("CMS measure rate")).toBeInTheDocument();
    expect(within(tile).getByText(/Initiation/)).toHaveTextContent("Initiation: 40.0%");
    expect(within(tile).getByText(/Engagement/)).toHaveTextContent("Engagement: 10.0%");
    expect(within(tile).getByText("2 evaluation errors not counted")).toBeInTheDocument();
    expect(within(tile).getByText(/the two can differ/)).toBeInTheDocument();
    expect(within(tile).queryByText(/counted in no rate/i)).toBeNull();
  });

  it("shows no CMS rate tile for a run without official evidence", async () => {
    mockPrograms({ ...base, measureRate: null });
    render(<ProgramDetailPage />);
    await screen.findByText("Compliance 40.0%");
    expect(screen.queryByTestId("measure-rate-cms137")).toBeNull();
  });

  it("links the staff-closed count to the cases list's Closed-by-staff tab, and hides it at zero", async () => {
    mockPrograms(withRate);
    const { unmount } = render(<ProgramDetailPage />);
    const link = await screen.findByRole("link", { name: /closed by staff, still counted: 4/i });
    expect(link).toHaveAttribute("href", "/cases?status=staff_closed&measureId=cms137");
    unmount();
    mockPrograms({ ...withRate, staffClosedGapCount: 0 });
    render(<ProgramDetailPage />);
    await screen.findByText("Compliance 40.0%");
    expect(screen.queryByText(/closed by staff/i)).toBeNull();
  });

  it("no longer shows a Not-in-population column", async () => {
    mockPrograms({ ...withRate, notInPopulation: 15000 });
    render(<ProgramDetailPage />);
    await screen.findByText("Compliance 40.0%");
    expect(screen.queryByText("Not in population")).toBeNull();
  });
});
