import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramDetailPage from "../page";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

let currentMeasureId = "cms125";
vi.mock("next/navigation", () => ({
  useParams: () => ({ measureId: currentMeasureId }),
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

describe("ProgramDetailPage crosswalk heading rendering", () => {
  beforeEach(() => {
    currentMeasureId = "cms125";
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
      if (url === "/api/programs" || url.startsWith("/api/programs?")) {
        return Promise.resolve([cmsProgram, oshaProgram]);
      }
      if (url.includes("/trend")) {
        return Promise.resolve([]);
      }
      if (url.includes("/top-drivers")) {
        return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      }
      if (url.includes("/risk-outlook")) {
        return Promise.resolve(null);
      }
      if (url.includes("/snapshots")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  });

  it("renders MIPS 112 · CMS125 · Breast Cancer Screening heading for cms125 program", async () => {
    currentMeasureId = "cms125";
    render(<ProgramDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MIPS 112 · CMS125 · Breast Cancer Screening" })).toBeInTheDocument();
    });
  });

  it("renders plain name heading for OSHA measure audiogram", async () => {
    currentMeasureId = "audiogram";
    render(<ProgramDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Annual Audiogram Completed" })).toBeInTheDocument();
    });
  });
});
