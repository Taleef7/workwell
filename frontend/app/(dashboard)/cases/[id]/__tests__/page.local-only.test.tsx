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
 * **Why this test is shaped around the DESKTOP button specifically.** The case page renders two
 * layouts: a `md:hidden` column and a `hidden md:grid` one. jsdom applies no media queries, so both
 * are in the tree and a bare `getByText(/not sent to WebChart/)` passes when the notice exists in
 * only one of them — which is exactly the bug review caught: the first version of this change
 * labelled the mobile column and left every desktop user, the primary audience, with an unlabelled
 * "Send outreach".
 *
 * So the assertion is anchored to the desktop button and walks up to its shared container. The two
 * layouts spell the button differently — "Send Outreach" in the mobile column, "Send outreach" in
 * the desktop one — which is what makes them separable here at all.
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

  it("labels the DESKTOP outreach action, not only the mobile one", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0));

    // The desktop button, by its own spelling.
    const desktopSend = screen.getByRole("button", { name: "Send outreach" });

    // Walk up until a container holds both the button and a notice. Without the desktop notice this
    // only terminates at a common ancestor that also contains the mobile column — so the loop is
    // bounded and the failure is a thrown error rather than a silent pass.
    let scope: HTMLElement | null = desktopSend.closest("div");
    let found = false;
    for (let hops = 0; hops < 4 && scope; hops += 1) {
      if (within(scope).queryAllByText(NOT_SENT).length > 0) {
        found = true;
        break;
      }
      scope = scope.parentElement;
    }
    expect(found, "the desktop outreach action has no local-only notice near it").toBe(true);
  });

  it("labels the mobile outreach action too", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => expect(screen.getAllByText("Alice Walker").length).toBeGreaterThan(0));

    const mobileSend = screen.getByRole("button", { name: "Send Outreach" });
    let scope: HTMLElement | null = mobileSend.closest("div");
    let found = false;
    for (let hops = 0; hops < 4 && scope; hops += 1) {
      if (within(scope).queryAllByText(NOT_SENT).length > 0) {
        found = true;
        break;
      }
      scope = scope.parentElement;
    }
    expect(found, "the mobile outreach action has no local-only notice near it").toBe(true);
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
