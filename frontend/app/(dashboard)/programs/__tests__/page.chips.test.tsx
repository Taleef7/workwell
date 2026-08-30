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

const program = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125",
  version: "FHIR v1",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 10,
  compliant: 2,
  dueSoon: 2,
  overdue: 2,
  missingData: 2,
  excluded: 2,
  complianceRate: 20,
  openCaseCount: 6,
};

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/programs/overview") return Promise.resolve([program]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    return Promise.resolve([]);
  });
});

describe("ProgramsPage status chips", () => {
  it("renders each actionable chip as a deep link into the pre-filtered cases list", async () => {
    render(<ProgramsPage />);
    const overdue = await screen.findByRole("link", { name: /overdue/i });
    expect(overdue).toHaveAttribute("href", "/cases?measureId=cms125&outcome=OVERDUE");
    expect(screen.getByRole("link", { name: /due soon/i })).toHaveAttribute(
      "href", "/cases?measureId=cms125&outcome=DUE_SOON");
    expect(screen.getByRole("link", { name: /missing data/i })).toHaveAttribute(
      "href", "/cases?measureId=cms125&outcome=MISSING_DATA");
  });

  it("links compliant and excluded chips to the status-filtered roster", async () => {
    render(<ProgramsPage />);
    expect(await screen.findByRole("link", { name: /compliant/i })).toHaveAttribute(
      "href", "/compliance?status=COMPLIANT");
    expect(screen.getByRole("link", { name: /excluded/i })).toHaveAttribute(
      "href", "/compliance?status=EXCLUDED");
  });
});
