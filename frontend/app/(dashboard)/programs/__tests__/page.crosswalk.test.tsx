import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramsPage from "../page";

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

const cmsProgram = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125",
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 10,
  compliant: 5,
  dueSoon: 2,
  overdue: 2,
  missingData: 1,
  excluded: 0,
  complianceRate: 50,
  openCaseCount: 4,
};

const oshaProgram = {
  measureId: "audiogram",
  measureName: "Annual Audiogram Completed",
  policyRef: "OSHA 1910.95",
  version: "v1.0",
  latestRunId: "run-2",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 20,
  compliant: 18,
  dueSoon: 1,
  overdue: 1,
  missingData: 0,
  excluded: 0,
  complianceRate: 90,
  openCaseCount: 2,
};

describe("ProgramsPage crosswalk heading rendering", () => {
  beforeEach(() => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms125",
            name: "Breast Cancer Screening",
            identity: { cmsId: "CMS125", mipsQualityId: "112" },
          },
          {
            id: "audiogram",
            name: "Annual Audiogram Completed",
            identity: null,
          },
        ]);
      }
      if (url.startsWith("/api/programs/overview")) {
        return Promise.resolve([cmsProgram, oshaProgram]);
      }
      if (url.includes("/top-drivers")) {
        return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      }
      return Promise.resolve([]);
    });
  });

  it("renders MIPS 112 · CMS125 · Breast Cancer Screening for cms125 and plain name for audiogram", async () => {
    render(<ProgramsPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MIPS 112 · CMS125 · Breast Cancer Screening" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Annual Audiogram Completed" })).toBeInTheDocument();
    });

    // Verify status chip ariaLabel uses the crosswalk label
    expect(screen.getByRole("link", { name: "MIPS 112 · CMS125 · Breast Cancer Screening: Overdue 2" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Annual Audiogram Completed: Overdue 1" })).toBeInTheDocument();
  });
});
