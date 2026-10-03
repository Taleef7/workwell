/**
 * WebChart calculates and submits the pilot group's reported rates; WorkWell's are an estimate from
 * CMS's FHIR logic. The programs overview says so once, beside the overall KPI, and every card's rate
 * points at that note. The occupational deployment's measures are WorkWell's own, so it says nothing.
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

const PROGRAM = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125v14",
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2026-09-30T12:03:00Z",
  totalEvaluated: 100,
  denominator: 100,
  compliant: 72,
  dueSoon: 0,
  overdue: 28,
  missingData: 0,
  excluded: 0,
  complianceRate: 72,
  openCaseCount: 28,
  measurementYear: 2026,
  asOf: "2026-09-30",
};

// The overview spans every measure and cannot see each run's provenance, so it names no engine.
const ESTIMATE = "WorkWell's estimate. WebChart calculates and submits the reported rate.";

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.includes("include=trend")) return Promise.resolve([{ ...PROGRAM, trend: [] }]);
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([PROGRAM]);
    return Promise.resolve([]);
  });
});

describe("ProgramsPage estimate caveat", () => {
  it("states once, on the patient deployment, that the rates are WorkWell's estimate, and the card rate points at it", async () => {
    setSubject("patient");
    render(<ProgramsPage />);
    const rate = await screen.findByText("Compliance 72.0%");
    expect(screen.getAllByText(ESTIMATE)).toHaveLength(1);
    expect(screen.getByText(ESTIMATE)).toHaveAttribute("id", "rate-estimate-note");
    expect(rate).toHaveAttribute("aria-describedby", expect.stringContaining("rate-estimate-note"));
    // The overall KPI points at the same note.
    expect(screen.getByText("Overall compliance").nextSibling).toHaveAttribute("aria-describedby", "rate-estimate-note");
  });

  it("says nothing of the kind on the occupational deployment", async () => {
    setSubject("employee");
    render(<ProgramsPage />);
    const rate = await screen.findByText("Compliance 72.0%");
    expect(screen.queryByText(ESTIMATE)).toBeNull();
    expect(rate.getAttribute("aria-describedby") ?? "").not.toContain("rate-estimate-note");
    expect(screen.getByText("Overall compliance").nextSibling).not.toHaveAttribute("aria-describedby");
  });
});
