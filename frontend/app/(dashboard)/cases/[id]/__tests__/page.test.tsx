import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import CaseDetailPage from "../page";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const apiMock = { get, post, patch };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "case-001" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" }, token: "test-token" }),
}));

function makeCaseDetail(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "case-001",
    employeeId: "emp-101",
    employeeName: "Alice Walker",
    measureId: "cms125",
    measureVersionId: "cms125",
    measureName: "Breast Cancer Screening",
    measureVersion: "1.0",
    evaluationPeriod: "2026-01-01",
    status: "OPEN",
    priority: "HIGH",
    assignee: null,
    nextAction: "Schedule screening appointment",
    currentOutcomeStatus: "OVERDUE",
    lastRunId: "run-001",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    closedReason: null,
    closedBy: null,
    exclusionReason: null,
    waiverExpiresAt: null,
    waiverExpired: false,
    evidenceJson: { expressionResults: [] },
    outcomeStatus: "OVERDUE",
    outcomeSummary: "Measure outcome is overdue and requires follow-up.",
    outcomeEvaluatedAt: "2026-01-01T00:00:00.000Z",
    latestOutreachDeliveryStatus: null,
    timeline: [],
    ...overrides,
  };
}

describe("CaseDetailPage crosswalk identity rendering", () => {
  beforeEach(() => {
    setSubject("employee");
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
      if (url === `/api/cases/case-001`) {
        return Promise.resolve({
          caseId: "case-001",
          employeeId: "emp-101",
          employeeName: "Alice Walker",
          measureId: "cms125",
          measureVersionId: "cms125",
          measureName: "Breast Cancer Screening",
          measureVersion: "1.0",
          evaluationPeriod: "2026-01-01",
          status: "OPEN",
          priority: "HIGH",
          assignee: null,
          nextAction: "Schedule screening appointment",
          currentOutcomeStatus: "OVERDUE",
          lastRunId: "run-001",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          closedReason: null,
          closedBy: null,
          exclusionReason: null,
          waiverExpiresAt: null,
          waiverExpired: false,
          evidenceJson: { expressionResults: [] },
          outcomeStatus: "OVERDUE",
          outcomeSummary: "Measure outcome is overdue and requires follow-up.",
          outcomeEvaluatedAt: "2026-01-01T00:00:00.000Z",
          latestOutreachDeliveryStatus: null,
          timeline: [],
        });
      }
      return Promise.resolve([]);
    });
  });

  it("renders crosswalk label MIPS 112 · CMS125 · Breast Cancer Screening for cms125 case in both mobile and desktop views", async () => {
    setSubject("patient");
    render(<CaseDetailPage />);
    await waitFor(() => {
      const elements = screen.getAllByText("MIPS 112 · CMS125 · Breast Cancer Screening");
      expect(elements).toHaveLength(2);
    });
    expect(screen.getByText("Measurement year: 2026")).toBeInTheDocument();
    expect(screen.getByText("Measurement year", { selector: "dt" })).toBeInTheDocument();
    expect(screen.queryByText("2026-01-01", { exact: true })).not.toBeInTheDocument();
  });

  it("renders plain name for an OSHA measure without identity crosswalk in both mobile and desktop views", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "audiogram",
            name: "Annual Audiogram Completed",
            identity: null,
          },
        ]);
      }
      if (url === `/api/cases/case-001`) {
        return Promise.resolve({
          caseId: "case-001",
          employeeId: "emp-102",
          employeeName: "Bob Builder",
          measureId: "audiogram",
          measureVersionId: "audiogram",
          measureName: "Annual Audiogram Completed",
          measureVersion: "1.0",
          evaluationPeriod: "2026-Q1",
          status: "OPEN",
          priority: "HIGH",
          assignee: null,
          nextAction: "Schedule audiogram",
          currentOutcomeStatus: "OVERDUE",
          lastRunId: "run-001",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          closedReason: null,
          closedBy: null,
          exclusionReason: null,
          waiverExpiresAt: null,
          waiverExpired: false,
          evidenceJson: { expressionResults: [] },
          outcomeStatus: "OVERDUE",
          outcomeSummary: "Measure outcome is overdue and requires follow-up.",
          outcomeEvaluatedAt: "2026-01-01T00:00:00.000Z",
          latestOutreachDeliveryStatus: null,
          timeline: [],
        });
      }
      return Promise.resolve([]);
    });

    render(<CaseDetailPage />);
    await waitFor(() => {
      const elements = screen.getAllByText("Annual Audiogram Completed", { exact: true });
      expect(elements).toHaveLength(2);
    });
    expect(screen.getByText("Period: 2026-Q1")).toBeInTheDocument();
    expect(screen.getByText("Evaluation period", { selector: "dt" })).toBeInTheDocument();
    expect(screen.queryByText(/^MIPS/)).not.toBeInTheDocument();
  });

  it("uses patient appointment types with Office visit as the default", async () => {
    setSubject("patient");
    render(<CaseDetailPage />);
    await screen.findAllByText("Alice Walker", { exact: true });
    await userEvent.click(screen.getByRole("button", { name: "Schedule Appointment" }));

    const appointmentType = await screen.findByRole("combobox", { name: "Appointment type" });
    expect(appointmentType).toHaveTextContent("Office visit");
    await userEvent.click(appointmentType);
    const appointmentOptions = await screen.findByRole("listbox");
    expect(within(appointmentOptions).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Office visit",
      "Telehealth visit",
      "Lab draw",
      "Imaging",
      "Other",
    ]);
  });

  it("keeps employee appointment types with Audiogram as the default", async () => {
    render(<CaseDetailPage />);
    await screen.findAllByText("Alice Walker", { exact: true });
    await userEvent.click(screen.getByRole("button", { name: "Schedule Appointment" }));

    const appointmentType = await screen.findByRole("combobox", { name: "Appointment type" });
    expect(appointmentType).toHaveTextContent("Audiogram");
    await userEvent.click(appointmentType);
    const appointmentOptions = await screen.findByRole("listbox");
    expect(within(appointmentOptions).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Audiogram",
      "TB Test",
      "Annual Physical",
      "Flu Vaccine",
      "Other",
    ]);
  });

  it.each([
    ["patient", "Exclusion status", "Documented exclusion on file", "Excluded by a documented exclusion."],
    ["employee", "Waiver status", "Active waiver on file", "Excluded by documented waiver or exemption."],
  ] as const)("uses the %s exclusion copy for an excluded case", async (term, statusLabel, fileLabel, fallback) => {
    setSubject(term);
    get.mockImplementation((url: string) => {
      if (url === "/api/cases/case-001") {
        return Promise.resolve({
          caseId: "case-001",
          employeeId: "emp-101",
          employeeName: "Alice Walker",
          measureId: "cms125",
          measureVersionId: "cms125",
          measureName: "Breast Cancer Screening",
          measureVersion: "1.0",
          evaluationPeriod: "2026-01-01",
          status: "EXCLUDED",
          priority: "HIGH",
          assignee: null,
          nextAction: "Document exclusion",
          currentOutcomeStatus: "EXCLUDED",
          lastRunId: "run-001",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          closedReason: null,
          closedBy: null,
          exclusionReason: null,
          waiverExpiresAt: null,
          waiverExpired: false,
          evidenceJson: { expressionResults: [] },
          outcomeStatus: "EXCLUDED",
          outcomeSummary: "Case is excluded.",
          outcomeEvaluatedAt: "2026-01-01T00:00:00.000Z",
          latestOutreachDeliveryStatus: null,
          timeline: [],
        });
      }
      return Promise.resolve([]);
    });

    render(<CaseDetailPage />);
    expect(await screen.findByText(statusLabel)).toBeInTheDocument();
    expect(screen.getByText(fileLabel)).toBeInTheDocument();
    expect(screen.getByText(fallback)).toBeInTheDocument();
  });

  it.each([
    ["patient", "its exclusion context."],
    ["employee", "its waiver context."],
  ] as const)("uses %s terminology in the case-detail hero", async (term, copy) => {
    setSubject(term);
    render(<CaseDetailPage />);
    const hero = screen.getByRole("heading", { name: "Case detail" }).parentElement;
    expect(await screen.findByText("Case detail")).toBeInTheDocument();
    expect(hero).toHaveTextContent(copy);
  });

  it.each([
    ["patient", "Exclusion no longer applies — rerun recommended"],
    ["employee", "Waiver Expired — Rerun Recommended"],
  ] as const)("uses %s terminology for an expired exclusion fixture", async (term, copy) => {
    setSubject(term);
    get.mockImplementation((url: string) =>
      url === "/api/cases/case-001"
        ? Promise.resolve(makeCaseDetail({
            status: "EXCLUDED",
            currentOutcomeStatus: "EXCLUDED",
            outcomeStatus: "EXCLUDED",
            waiverExpiresAt: "2025-01-01T00:00:00.000Z",
            waiverExpired: true,
          }))
        : Promise.resolve([])
    );

    render(<CaseDetailPage />);
    expect(await screen.findByText(copy, { exact: true })).toBeInTheDocument();
  });

  it.each([
    ["employee", true],
    ["patient", false],
  ] as const)("%s %s raw why_flagged JSON in the default evidence block", async (term, rendersRawJson) => {
    setSubject(term);
    get.mockImplementation((url: string) =>
      url === "/api/cases/case-001"
        ? Promise.resolve(makeCaseDetail({
            evidenceJson: {
              expressionResults: [],
              why_flagged: {
                last_exam_date: "2025-08-10",
                compliance_window_days: 365,
                days_overdue: 12,
                role_eligible: true,
                site_eligible: true,
                waiver_status: "NONE",
              },
            },
          }))
        : Promise.resolve([])
    );

    render(<CaseDetailPage />);
    await screen.findByText("why_flagged");
    expect(screen.getByRole("button", { name: "View Raw Evidence" })).toBeInTheDocument();
    if (rendersRawJson) {
      expect(screen.getByText(/"last_exam_date"/)).toBeInTheDocument();
    } else {
      expect(screen.queryByText(/"last_exam_date"/)).not.toBeInTheDocument();
    }
  });

  it.each([
    [{ dueDate: "2026-09-30" }, true],
    [{}, false],
  ] as const)("renders the Due date line only when the outreach preview includes it", async (preview, hasDueDate) => {
    get.mockImplementation((url: string) => {
      if (url === "/api/cases/case-001") return Promise.resolve(makeCaseDetail());
      if (url.includes("/actions/outreach/preview")) {
        return Promise.resolve({
          templateName: "Follow-up",
          subject: "Screening follow-up",
          bodyText: "Please follow up.",
          employeeName: "Alice Walker",
          measureName: "Breast Cancer Screening",
          ...preview,
        });
      }
      return Promise.resolve([]);
    });

    render(<CaseDetailPage />);
    await screen.findAllByText("Alice Walker", { exact: true });
    await userEvent.click(screen.getByRole("button", { name: "Preview outreach" }));
    await screen.findByText("Outreach preview");
    if (hasDueDate) {
      expect(screen.getByText(/Due date:/)).toBeInTheDocument();
    } else {
      expect(screen.queryByText(/Due date:/)).not.toBeInTheDocument();
    }
  });

  it("keeps an employee-term canonical year period raw in case detail", async () => {
    setSubject("employee");
    render(<CaseDetailPage />);
    expect(await screen.findByText("Period: 2026-01-01", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("2026", { exact: true })).not.toBeInTheDocument();
  });
});
