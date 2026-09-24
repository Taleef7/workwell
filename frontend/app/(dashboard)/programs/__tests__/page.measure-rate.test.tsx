import React from "react";
import { render, screen } from "@testing-library/react";
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

/** A card shows ONE rate (#637). The CMS measure rate — the run's evidence reduced the way the
 *  MeasureReport reports it (ADR-077 d5) — lives on the measure page, not beside it on the card. */
const program = {
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
  measureRate: {
    source: "official-evidence",
    runId: "run-1",
    official: { ecqmId: "CMS137FHIR", version: "1.0.000" },
    rates: [{ label: "Initiation", ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 4, effectiveDenominator: 10, score: 0.4 }],
    unmeasured: 2,
    evaluationErrors: 2,
  },
};

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
    return Promise.resolve([]);
  });
});

describe("ProgramsPage — one rate per card (#637)", () => {
  it("shows the card's rate and not the CMS measure-rate tile, which lives on the measure page", async () => {
    render(<ProgramsPage />);
    expect(await screen.findByText("Compliance 40.0%")).toBeInTheDocument();
    expect(screen.queryByTestId("measure-rate-cms137")).not.toBeInTheDocument();
    expect(screen.queryByText(/CMS measure rate|official evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/counted in no rate/i)).not.toBeInTheDocument();
  });

  it("drops the card clutter: no drivers, no reason mix, no second link to the same page", async () => {
    render(<ProgramsPage />);
    await screen.findByText("Compliance 40.0%");
    for (const gone of [/Top Sites/i, /Top Roles/i, /By Reason/i, /View detail/i, /Workflow status/i, /Evaluations \(latest runs\)/i]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    // What stays: the worklist link, and the whole card still opens the measure page.
    expect(screen.getByRole("link", { name: /Open cases \(6\)/ })).toHaveAttribute("href", "/cases?measureId=cms137");
    expect(screen.getByRole("link", { name: /View .* detail/ })).toHaveAttribute("href", "/programs/cms137");
  });
});
