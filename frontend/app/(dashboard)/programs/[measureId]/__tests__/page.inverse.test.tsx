import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramDetailPage from "../page";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

let currentMeasureId = "cms122";
vi.mock("next/navigation", () => ({
  useParams: () => ({ measureId: currentMeasureId }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

const cms122Program = {
  measureId: "cms122",
  measureName: "Diabetes: Glycemic Status Assessment",
  policyRef: "CMS122",
  version: "v1.0",
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

beforeEach(() => {
  currentMeasureId = "cms122";
  get.mockImplementation((url: string) => {
    if (url === "/api/measures") {
      return Promise.resolve([
        {
          id: "cms122",
          name: "Diabetes: Glycemic Status Assessment",
          identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" },
        },
      ]);
    }
    if (url === "/api/programs" || url.startsWith("/api/programs?")) {
      return Promise.resolve([cms122Program]);
    }
    if (url.includes("/trend")) return Promise.resolve([]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    if (url.includes("/risk-outlook")) return Promise.resolve(null);
    if (url.includes("/snapshots")) return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe("ProgramDetailPage inverse measure rendering", () => {
  it("renders CMS122 as Poor control 15.6% with Lower is better note and accessible association", async () => {
    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    const note = screen.getByText("Lower is better");
    expect(note).toBeInTheDocument();
    const deltaEl = screen.getByText(/from previous/);
    expect(deltaEl).toHaveAttribute("aria-describedby", note.id);
  });

  it("asserts no 'Compliance' label appears anywhere on the page for cms122 and run-history shows poor control", async () => {
    const trendPoint = {
      runId: "run-1-id-12345678",
      startedAt: "2026-08-30T00:00:00Z",
      complianceRate: 84.4,
      totalEvaluated: 48,
      denominator: 45,
      compliant: 38,
      dueSoon: 0,
      overdue: 7,
      missingData: 0,
      excluded: 3,
    };
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms122",
            name: "Diabetes: Glycemic Status Assessment",
            identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" },
          },
        ]);
      }
      if (url === "/api/programs" || url.startsWith("/api/programs?")) {
        return Promise.resolve([cms122Program]);
      }
      if (url.includes("/trend")) return Promise.resolve([trendPoint]);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      if (url.includes("/quality/history")) {
        return Promise.resolve([
          {
            measureId: "cms122",
            period: "2026-08",
            scopeLevel: "all",
            scopeId: "ALL",
            tenantId: null,
            numerator: 38,
            denominator: 45,
            compliant: 38,
            dueSoon: 0,
            overdue: 7,
            missingData: 0,
            excluded: 3,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();

    // Verify run history column header and value
    const tableHeaders = screen.getAllByRole("columnheader", { name: "Poor control" });
    expect(tableHeaders.length).toBeGreaterThanOrEqual(1);
    const cells = screen.getAllByRole("cell");
    expect(cells.some((c) => c.textContent === "15.6%")).toBe(true);

    // Verify no "Compliance" label appears anywhere on the page
    expect(screen.queryByText(/Compliance/)).toBeNull();

    // The snapshot tile and its data table pair the poor-control rate with the overdue numerator and
    // the denominator that rate was divided by — never the persisted compliant numerator (38 / 45).
    expect((await screen.findAllByText("7 / 45")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("38 / 45")).toBeNull();
    const snapshotTable = await screen.findByRole("table", { name: /Monthly poor control/i });
    const snapshotCells = Array.from(snapshotTable.querySelectorAll("td")).map((c) => c.textContent);
    expect(snapshotCells).toEqual(expect.arrayContaining(["15.6%", "7", "45"]));
    expect(snapshotCells).not.toContain("38");
  });

  it("labels the risk-outlook site table as in-control rates for a decrease measure (never a compliance-looking rate under Poor control)", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          { id: "cms122", name: "Diabetes: Glycemic Status Assessment", identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" } },
        ]);
      }
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve([cms122Program]);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      if (url.includes("/risk-outlook")) {
        return Promise.resolve({
          upcomingNonCompliantCount: 0,
          repeatNonCompliers: [],
          siteComplianceRates: [{ site: "Kihei Clinic", currentComplianceRate: 84.4, predictedComplianceRate: 84.4, upcomingExpirations: 0 }],
        });
      }
      return Promise.resolve([]);
    });
    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    expect(await screen.findByRole("columnheader", { name: "In control now" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "In control in 90d" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Current rate" })).toBeNull();
  });

  it("renders Poor control from the program's own improvementNotation when /api/measures fails", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.reject(new Error("identities unavailable"));
      if (url === "/api/programs" || url.startsWith("/api/programs?")) {
        return Promise.resolve([{ ...cms122Program, improvementNotation: "decrease" }]);
      }
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      return Promise.resolve([]);
    });
    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    expect(screen.getByText("Lower is better")).toBeInTheDocument();
  });

  it("shows good tone (emerald) and downward arrow when poor control fell", async () => {
    const trendPoints = [
      {
        runId: "run-2-newer",
        startedAt: "2026-08-30T00:00:00Z",
        complianceRate: 84.4,
        totalEvaluated: 48,
        denominator: 45,
        compliant: 38,
        dueSoon: 0,
        overdue: 7,
        missingData: 0,
        excluded: 3,
      },
      {
        runId: "run-1-older",
        startedAt: "2026-08-20T00:00:00Z",
        complianceRate: 77.8,
        totalEvaluated: 48,
        denominator: 45,
        compliant: 35,
        dueSoon: 0,
        overdue: 10,
        missingData: 0,
        excluded: 3,
      },
    ];
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms122",
            name: "Diabetes: Glycemic Status Assessment",
            identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" },
          },
        ]);
      }
      if (url === "/api/programs" || url.startsWith("/api/programs?")) {
        return Promise.resolve([cms122Program]);
      }
      if (url.includes("/trend")) return Promise.resolve(trendPoints);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      if (url.includes("/quality/history")) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();

    const deltaEl = screen.getByText(/from previous/);
    expect(deltaEl.textContent).toContain("↓");
    expect(deltaEl.className).toContain("text-emerald-700");
  });

  it("shows bad tone (rose) and upward arrow when poor control rose", async () => {
    const trendPoints = [
      {
        runId: "run-2-newer",
        startedAt: "2026-08-30T00:00:00Z",
        complianceRate: 84.4,
        totalEvaluated: 48,
        denominator: 45,
        compliant: 38,
        dueSoon: 0,
        overdue: 7,
        missingData: 0,
        excluded: 3,
      },
      {
        runId: "run-1-older",
        startedAt: "2026-08-20T00:00:00Z",
        complianceRate: 93.3,
        totalEvaluated: 48,
        denominator: 45,
        compliant: 42,
        dueSoon: 0,
        overdue: 3,
        missingData: 0,
        excluded: 3,
      },
    ];
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms122",
            name: "Diabetes: Glycemic Status Assessment",
            identity: { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" },
          },
        ]);
      }
      if (url === "/api/programs" || url.startsWith("/api/programs?")) {
        return Promise.resolve([cms122Program]);
      }
      if (url.includes("/trend")) return Promise.resolve(trendPoints);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      if (url.includes("/quality/history")) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();

    const deltaEl = screen.getByText(/from previous/);
    expect(deltaEl.textContent).toContain("↑");
    expect(deltaEl.className).toContain("text-rose-700");
  });

  it("passes viewer timezone in tz query parameter when fetching per-run trend", async () => {
    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(get).toHaveBeenCalledWith(expect.stringContaining(`/api/programs/cms122/trend?tz=${encodeURIComponent(tz)}`));
  });
});
