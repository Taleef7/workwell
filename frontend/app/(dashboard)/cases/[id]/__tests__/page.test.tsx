import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("CaseDetailPage crosswalk identity rendering", () => {
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
      if (url === `/api/cases/case-001`) {
        return Promise.resolve({
          caseId: "case-001",
          employeeId: "emp-101",
          employeeName: "Alice Walker",
          measureId: "cms125",
          measureVersionId: "cms125",
          measureName: "Breast Cancer Screening",
          measureVersion: "1.0",
          evaluationPeriod: "2026-Q1",
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

  it("renders crosswalk label MIPS 112 · CMS125 · Breast Cancer Screening for cms125 case", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => {
      const elements = screen.getAllByText("MIPS 112 · CMS125 · Breast Cancer Screening");
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders plain name for an OSHA measure without identity crosswalk", async () => {
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
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText(/^MIPS/)).not.toBeInTheDocument();
  });
});
