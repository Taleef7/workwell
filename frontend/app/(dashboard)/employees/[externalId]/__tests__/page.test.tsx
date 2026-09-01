import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EmployeeProfilePage from "../page";

const get = vi.fn();
const post = vi.fn();
const apiMock = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ externalId: "emp-001" }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/features/employee/components/IndividualComplianceStatus", () => ({
  IndividualComplianceStatus: () => <div data-testid="individual-compliance-status" />,
}));
vi.mock("@/features/employee/components/SimulateComplianceHistory", () => ({
  SimulateComplianceHistory: () => <div data-testid="simulate-compliance-history" />,
}));

const mockProfile = {
  id: "emp-001",
  externalId: "emp-001",
  name: "Jane Doe",
  role: "Engineer",
  site: "Plant A",
  supervisorName: null,
  startDate: null,
  fhirPatientId: null,
  active: true,
  measureOutcomes: [
    {
      measureId: "cms125",
      measureVersionId: "cms125",
      measureName: "Breast Cancer Screening",
      measureVersion: "v1.0",
      outcomeStatus: "OVERDUE",
      lastRunDate: "2026-01-01T00:00:00Z",
      daysSinceLastExam: null,
      daysUntilDue: null,
      openCaseId: "case-001",
    },
    {
      measureId: "audiogram",
      measureVersionId: "audiogram",
      measureName: "Annual Audiogram Completed",
      measureVersion: "v1.0",
      outcomeStatus: "COMPLIANT",
      lastRunDate: "2026-01-01T00:00:00Z",
      daysSinceLastExam: 100,
      daysUntilDue: 265,
      openCaseId: null,
    },
  ],
  openCases: [
    {
      caseId: "case-001",
      measureId: "cms125",
      measureName: "Breast Cancer Screening",
      outcomeStatus: "OVERDUE",
      priority: "HIGH",
      assignee: "cm@workwell.dev",
      slaDueDate: null,
      slaRemainingDays: null,
      slaBreached: false,
    },
  ],
  recentAuditEvents: [],
};

describe("EmployeeProfilePage crosswalk identity rendering", () => {
  beforeEach(() => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms125",
            name: "Breast Cancer Screening",
            status: "Active",
            identity: { cmsId: "CMS125", mipsQualityId: "112" },
          },
          {
            id: "audiogram",
            name: "Annual Audiogram Completed",
            status: "Active",
            identity: null,
          },
        ]);
      }
      if (url === "/api/employees/emp-001/profile") {
        return Promise.resolve(mockProfile);
      }
      return Promise.resolve([]);
    });
  });

  it("renders crosswalk label for cms125 outcome row and plain name for audiogram", async () => {
    render(<EmployeeProfilePage />);
    await waitFor(() => {
      const elements = screen.getAllByText(/MIPS 112 · CMS125 · Breast Cancer Screening/);
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });

    const audiogramElements = screen.getAllByText(/Annual Audiogram Completed/);
    expect(audiogramElements.length).toBeGreaterThanOrEqual(1);
    const measureSection = screen.getByText("Measure Details").closest("div");
    expect(measureSection).toHaveTextContent("Annual Audiogram Completed");
    expect(measureSection).toHaveTextContent("MIPS 112 · CMS125 · Breast Cancer Screening");
  });
});
