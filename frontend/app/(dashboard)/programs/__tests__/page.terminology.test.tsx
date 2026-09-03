import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

import ProgramsPage from "../page";

const program = {
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

beforeEach(() => {
  setSubject("patient");
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
    if (url.includes("/top-drivers")) {
      return Promise.resolve({ bySite: [], byRole: [{ role: "Nurse", overdueCount: 1 }], byOutcomeReason: [] });
    }
    return Promise.resolve([]);
  });
});

describe("ProgramsPage terminology", () => {
  it("hides Top Roles for the patient term", async () => {
    render(<ProgramsPage />);
    const topSites = await screen.findByText("Top Sites");
    await waitFor(() => expect(get).toHaveBeenCalledWith(expect.stringContaining("/top-drivers")));

    expect(screen.queryByText("Top Roles")).not.toBeInTheDocument();
    expect(topSites.parentElement).toHaveClass("sm:col-span-2");
  });

  it("keeps Top Roles for the employee term", async () => {
    setSubject("employee");
    render(<ProgramsPage />);

    expect(await screen.findByText("Top Roles")).toBeInTheDocument();
    expect(await screen.findByText("Nurse")).toBeInTheDocument();
  });
});
