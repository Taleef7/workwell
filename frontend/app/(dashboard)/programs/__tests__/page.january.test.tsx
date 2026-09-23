/**
 * #637 — what the programs page says on 1 January, when a new measurement year's first run replaces
 * last year's final numbers and every measure starts with a handful of patients or none.
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

const summary = (over: Record<string, unknown>) => ({
  policyRef: "CMS",
  version: "FHIR v1",
  latestRunId: "run-27",
  latestRunAt: "2027-01-06T12:03:00Z",
  totalEvaluated: 20000,
  excluded: 0,
  openCaseCount: 0,
  measurementYear: 2027,
  asOf: "2027-01-06",
  ...over,
});

// Nobody counted yet: every workflow bucket empty (the 20,000 rows are all outside the population).
const empty = summary({ measureId: "cms137", measureName: "Substance use treatment", denominator: 0, compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, complianceRate: null });
// A handful counted: a real rate on seven patients.
const small = summary({ measureId: "cms122", measureName: "Diabetes", improvementNotation: "decrease", denominator: 7, compliant: 2, dueSoon: 0, overdue: 5, missingData: 0, complianceRate: 28.6 });

function mockOverview(programs: unknown[], trend: Record<string, unknown[]> = {}) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.includes("include=trend")) return Promise.resolve((programs as Array<{ measureId: string }>).map((p) => ({ ...p, trend: trend[p.measureId] ?? [] })));
    if (url.startsWith("/api/programs/overview")) return Promise.resolve(programs);
    return Promise.resolve([]);
  });
}

beforeEach(() => setSubject("patient"));

describe("ProgramsPage on 1 January (#637)", () => {
  it("says which year the page describes", async () => {
    mockOverview([empty, small]);
    render(<ProgramsPage />);
    expect(await screen.findByText("Measurement year 2027 · year to date, as of Jan 6, 2027")).toBeInTheDocument();
  });

  it("shows no rate, not 0%, for a measure with nobody counted yet", async () => {
    mockOverview([empty]);
    render(<ProgramsPage />);
    expect(await screen.findByText("No patients counted yet")).toBeInTheDocument();
    expect(screen.getByText("No results yet")).toBeInTheDocument();
    expect(screen.queryByText(/0\.0%/)).toBeNull();
  });

  it("puts the overall KPI at — rather than 0.0% when nobody is counted anywhere", async () => {
    mockOverview([empty]);
    render(<ProgramsPage />);
    await screen.findByText("No patients counted yet");
    expect(screen.getByText("Overall compliance").nextSibling).toHaveTextContent("—");
  });

  it("warns when a rate rests on a handful of patients", async () => {
    mockOverview([small]);
    render(<ProgramsPage />);
    expect(await screen.findByText("Poor control 71.4%")).toBeInTheDocument();
    expect(screen.getByText("Based on 7 patients so far")).toBeInTheDocument();
  });

  it("never draws a trend from last year's final run into this year's first", async () => {
    const pt = (runId: string, startedAt: string, measurementYear: number, compliant: number, overdue: number) => ({
      runId, startedAt, measurementYear, totalEvaluated: 20000, denominator: compliant + overdue, compliant, dueSoon: 0, overdue, missingData: 0, excluded: 0, complianceRate: null,
    });
    mockOverview([small], {
      cms122: [pt("run-26", "2026-12-31T12:03:00Z", 2026, 900, 1100), pt("run-27", "2027-01-06T12:03:00Z", 2027, 2, 5)],
    });
    render(<ProgramsPage />);
    expect(await screen.findByText("Trend appears after a few more runs")).toBeInTheDocument();
    expect(screen.queryByText(/from last run/)).toBeNull();
  });
});
