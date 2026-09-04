import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
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
  supervisorName: "Manager Smith",
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
    setSubject("employee");
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
    await waitFor(() => expect(screen.getByText("Compliance Posture")).toBeInTheDocument());

    const summaryBar = screen.getByText("Compliance Posture").parentElement!;
    expect(within(summaryBar).getByText(
      "MIPS 112 · CMS125 · Breast Cancer Screening — OVERDUE",
      { exact: true },
    )).toBeInTheDocument();
    expect(within(summaryBar).getByText("Annual Audiogram Completed — COMPLIANT", { exact: true })).toBeInTheDocument();

    // Open-case row: assert CMS label on the open-case link/row (page.tsx ~110)
    const openCaseLink = screen.getByRole("link", { name: "MIPS 112 · CMS125 · Breast Cancer Screening" });
    expect(openCaseLink).toHaveAttribute("href", "/cases/case-001");
    const openCaseRow = openCaseLink.closest<HTMLTableRowElement>("tr")!;
    expect(within(openCaseRow).getByText("MIPS 112 · CMS125 · Breast Cancer Screening", { exact: true })).toBeInTheDocument();

    // CMS measure-detail row (page.tsx ~151)
    const cmsOutcomeRow = document.getElementById("measure-cms125")!;
    expect(within(cmsOutcomeRow).getByText("MIPS 112 · CMS125 · Breast Cancer Screening", { exact: true })).toBeInTheDocument();

    // OSHA measure-detail row
    const oshaOutcomeRow = document.getElementById("measure-audiogram")!;
    expect(within(oshaOutcomeRow).getByText("Annual Audiogram Completed", { exact: true })).toBeInTheDocument();
    expect(within(oshaOutcomeRow).queryByText(/^MIPS/)).not.toBeInTheDocument();
  });

  it("hides role and supervisor for patients, while keeping employee profile details byte-identical", async () => {
    setSubject("patient");
    const { unmount } = render(<EmployeeProfilePage />);
    await screen.findByText("Jane Doe", { exact: true });
    expect(screen.queryByText(/Engineer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Supervisor: Manager Smith/)).not.toBeInTheDocument();
    expect(screen.getByText(/Plant A/)).toBeInTheDocument();

    unmount();
    setSubject("employee");
    render(<EmployeeProfilePage />);
    await screen.findByText("Jane Doe", { exact: true });
    expect(screen.getByText("Engineer · Plant A · Supervisor: Manager Smith")).toBeInTheDocument();
  });

  it("uses result wording for patients and exam wording for employees", async () => {
    setSubject("patient");
    const { unmount } = render(<EmployeeProfilePage />);
    await screen.findByText("Days since result: 100", { exact: true });
    expect(screen.queryByText("Days since exam: 100", { exact: true })).not.toBeInTheDocument();

    unmount();
    setSubject("employee");
    render(<EmployeeProfilePage />);
    expect(await screen.findByText("Days since exam: 100", { exact: true })).toBeInTheDocument();
  });
});
