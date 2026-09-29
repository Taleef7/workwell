import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CaseDetailPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { role: "ROLE_CASE_MANAGER" },
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

const NOT_SENT = /not sent to WebChart/i;

/**
 * §8E — every control that writes only a WorkWell row must say so.
 *
 * The notice is checked beside the button it labels, walking up to their shared container, not with a
 * bare `getByText`: the page once had a phone layout and a desktop one, and a notice present in only one
 * of them passed a page-wide query. There is one layout now (#700); the anchored check still catches a
 * notice that drifts away from its button.
 */
describe("CaseDetailPage — local-only action notices", () => {
  beforeEach(() => {
    setPublicDemo(false);
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.resolve([]);
      if (url === "/api/cases/case-001") return Promise.resolve(caseData);
      if (url === "/api/users/assignable") return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it("labels the outreach action", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0));

    const desktopSend = screen.getByRole("button", { name: "Send outreach" });

    // Walk up until a container holds both the button and a notice; bounded, so a missing notice is a
    // failure rather than a match on some distant ancestor.
    let scope: HTMLElement | null = desktopSend.closest("div");
    let found = false;
    for (let hops = 0; hops < 4 && scope; hops += 1) {
      if (within(scope).queryAllByText(NOT_SENT).length > 0) {
        found = true;
        break;
      }
      scope = scope.parentElement;
    }
    expect(found, "the outreach action has no local-only notice near it").toBe(true);
  });

  it("has ONE outreach action at every width, and it cannot send before a preview (#700)", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0));

    // The phone accordion had its own "Send Outreach", which sent with no preview; there is one now.
    expect(screen.queryByRole("button", { name: "Send Outreach" })).toBeNull();
    const sends = screen.getAllByRole("button", { name: "Send outreach" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toBeDisabled();
  });

  it("tells the truth about an uploaded document AND about the measure", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0));

    // The practice asked on 2026-09-10 whether an upload with the right document type fulfils the
    // measure. Saying only "not sent to WebChart" would leave the more consequential belief intact.
    expect(screen.getByText(/does not satisfy the measure/i)).toBeInTheDocument();
  });

  it("states it as an absent capability, not as an error", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0));

    for (const notice of screen.getAllByText(NOT_SENT)) {
      expect(notice.textContent ?? "").not.toMatch(/error|failed|warning|cannot be saved/i);
    }
  });
});
