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

const cms122Program = {
  measureId: "cms122",
  measureName: "Diabetes: Glycemic Status Assessment",
  policyRef: "CMS122",
  version: "FHIR v1",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 48,
  denominator: 45,
  compliant: 38,
  dueSoon: 0,
  overdue: 7,
  missingData: 0,
  excluded: 3,
  complianceRate: 84.4,
  openCaseCount: 7,
};

const cms125Program = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125",
  version: "FHIR v1",
  latestRunId: "run-2",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 48,
  denominator: 48,
  compliant: 38,
  dueSoon: 0,
  overdue: 0,
  missingData: 0,
  excluded: 0,
  complianceRate: 79.2,
  openCaseCount: 0,
};

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") {
      return Promise.resolve([
        { id: "cms122", name: "Diabetes: Glycemic Status Assessment", identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" } },
        { id: "cms125", name: "Breast Cancer Screening", identity: { cmsId: "CMS125", mipsQualityId: "112", improvementNotation: "increase" } },
      ]);
    }
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([cms122Program, cms125Program]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    return Promise.resolve([]);
  });
});

describe("ProgramsPage inverse measure rendering", () => {
  it("renders CMS122 as Poor control with Lower is better note, matching numerator 7 / 45, and accessible association", async () => {
    render(<ProgramsPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    const note = screen.getByText("Lower is better");
    expect(note).toBeInTheDocument();
    expect(screen.getByText("7 / 45")).toBeInTheDocument();
    expect(note.id).toBeTruthy();
  });

  it("renders CMS125 as a compliance percentage with Compliance 79.2%", async () => {
    render(<ProgramsPage />);
    await screen.findByText("Poor control 15.6%");
    expect(screen.getByText("Compliance 79.2%")).toBeInTheDocument();
    expect(screen.queryByText("· lower is better")).toBeNull();
    expect(screen.getAllByText(/lower is better/i).length).toBe(1);
  });

  it("renders CMS122 as Poor control from the summary's own improvementNotation when /api/measures fails", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.reject(new Error("identities unavailable"));
      if (url.startsWith("/api/programs/overview")) {
        return Promise.resolve([{ ...cms122Program, improvementNotation: "decrease" }, { ...cms125Program, improvementNotation: "increase" }]);
      }
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      return Promise.resolve([]);
    });
    render(<ProgramsPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    expect(screen.getByText("7 / 45")).toBeInTheDocument();
    expect(screen.getByText("Compliance 79.2%")).toBeInTheDocument();
    expect(screen.queryByText("Compliance 84.4%")).toBeNull();
  });

  it("renders CMS122 as Poor control when /api/measures resolves with a null identity row (falls back to the summary's notation)", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([{ id: "cms122", name: "Diabetes: Glycemic Status Assessment", identity: null }]);
      }
      if (url.startsWith("/api/programs/overview")) return Promise.resolve([{ ...cms122Program, improvementNotation: "decrease" }]);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      return Promise.resolve([]);
    });
    render(<ProgramsPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
  });

  it("computes Overall compliance KPI using denominator fallback (compliant 38 / excluded 3 / totalEvaluated 48 -> 84.4%)", async () => {
    const singleProg = {
      ...cms122Program,
      denominator: undefined, // test fallback to totalEvaluated - excluded
    };
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          { id: "cms122", name: "Diabetes: Glycemic Status Assessment", identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" } },
        ]);
      }
      if (url.startsWith("/api/programs/overview")) return Promise.resolve([singleProg]);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      return Promise.resolve([]);
    });

    render(<ProgramsPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    expect(screen.getByText("84.4%")).toBeInTheDocument();
  });

  it("inverts TrendChart delta tone for decrease measure when rate fell and rose", async () => {
    const fellTrend = [
      { runId: "r1", startedAt: "2026-08-01T00:00:00Z", complianceRate: 80, totalEvaluated: 45, compliant: 35, dueSoon: 0, overdue: 10, missingData: 0, excluded: 0 },
      { runId: "r2", startedAt: "2026-08-15T00:00:00Z", complianceRate: 84.4, totalEvaluated: 45, compliant: 38, dueSoon: 0, overdue: 7, missingData: 0, excluded: 0 },
    ];
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          { id: "cms122", name: "Diabetes: Glycemic Status Assessment", identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" } },
        ]);
      }
      if (url.startsWith("/api/programs/overview")) return Promise.resolve([cms122Program]);
      if (url.includes("/trend")) return Promise.resolve(fellTrend);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      return Promise.resolve([]);
    });

    const { unmount } = render(<ProgramsPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    const fellDelta = await screen.findByText(/from last run/);
    expect(fellDelta.textContent).toContain("↓");
    expect(fellDelta.className).toContain("text-emerald-600");
    unmount();

    // Now test when poor control rose
    const roseTrend = [
      { runId: "r1", startedAt: "2026-08-01T00:00:00Z", complianceRate: 90, totalEvaluated: 45, compliant: 42, dueSoon: 0, overdue: 3, missingData: 0, excluded: 0 },
      { runId: "r2", startedAt: "2026-08-15T00:00:00Z", complianceRate: 84.4, totalEvaluated: 45, compliant: 38, dueSoon: 0, overdue: 7, missingData: 0, excluded: 0 },
    ];
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          { id: "cms122", name: "Diabetes: Glycemic Status Assessment", identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" } },
        ]);
      }
      if (url.startsWith("/api/programs/overview")) return Promise.resolve([cms122Program]);
      if (url.includes("/trend")) return Promise.resolve(roseTrend);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      return Promise.resolve([]);
    });

    render(<ProgramsPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    const roseDelta = await screen.findByText(/from last run/);
    expect(roseDelta.textContent).toContain("↑");
    expect(roseDelta.className).toContain("text-rose-600");
  });
});
