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
  denominator: 10,
  compliant: 5,
  dueSoon: 1,
  overdue: 3,
  missingData: 1,
  excluded: 0,
  complianceRate: 50,
  openCaseCount: 3,
  staffClosedGapCount: 4,
};

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
    return Promise.resolve([]);
  });
});

describe("ProgramsPage — the staff-closed reconciliation (#569)", () => {
  it("is not on the card; it moved to the measure page with the other detail (#637)", async () => {
    render(<ProgramsPage />);
    await screen.findByText("Compliance 50.0%");
    expect(screen.queryByText(/closed by staff/i)).not.toBeInTheDocument();
    // The card keeps its worklist link and its chips.
    expect(screen.getByRole("link", { name: /Open cases \(3\)/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /overdue/i })).toHaveAttribute("href", "/compliance?measureId=cms125&status=OVERDUE");
  });
});
