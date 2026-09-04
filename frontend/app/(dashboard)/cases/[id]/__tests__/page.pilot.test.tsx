import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CaseDetailPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { role: currentRole },
    token: "test-token",
    updateToken: () => {},
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "case-001" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get, post, patch }),
}));

const caseData = {
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
  latestOutreachDeliveryStatus: "SENT",
  timeline: [],
};

describe("CaseDetailPage pilot mode controls", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.resolve([]);
      if (url === "/api/cases/case-001") return Promise.resolve(caseData);
      if (url === "/api/users/assignable") return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it("hides Escalate, Rerun to verify, Mark queued, Mark sent, Mark failed for non-admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<CaseDetailPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0);
    });

    expect(screen.queryAllByRole("button", { name: /^Escalate/i })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /Rerun to verify/i })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Mark queued/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mark sent/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mark failed/i })).toBeNull();
  });

  it("companion: shows controls for non-admin when PUBLIC_DEMO is true", async () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<CaseDetailPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByRole("button", { name: /^Escalate/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Rerun to verify/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Mark queued/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark sent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark failed/i })).toBeInTheDocument();
  });
});
