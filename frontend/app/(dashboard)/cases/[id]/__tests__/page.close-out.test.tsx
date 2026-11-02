/**
 * A case of a year that has ended (#882). The year's first nightly closed every open case of the year
 * before (`CYCLE_ROLLED_OVER`, a system closure). Such a case says why it closed, takes no outreach, and
 * a re-check records the year's result without reopening it. A closed case of the current year is
 * unchanged. "Ended" is by the browser's own calendar; the clock is faked for `Date` only.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { setPublicDemo } from "@/test/mocks/public-demo";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_QUALITY_STAFF" }, token: "test-token", updateToken: () => {} }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "case-001" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
const get = vi.fn();
const post = vi.fn();
// One client for the page's life, as `useApi` gives: a new object per render re-runs every load effect.
const apiMock = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
const emitToast = vi.fn();
vi.mock("@/lib/toast", () => ({ emitToast: (...args: unknown[]) => emitToast(...args) }));

import CaseDetailPage from "../page";

/** A 2026 gap the first nightly of 2027 closed: a system closure, so `closedBy` is null. */
const ROLLED_OVER = {
  caseId: "case-001",
  employeeId: "maui-pat-00001",
  employeeName: "Lisa Carter",
  measureId: "cms125",
  measureVersionId: "cms125",
  measureName: "Breast Cancer Screening",
  measureVersion: "1.0",
  evaluationPeriod: "2026-01-01",
  status: "RESOLVED",
  priority: "HIGH",
  assignee: null,
  nextAction: "Order a mammogram",
  nextActionSource: "SYSTEM",
  currentOutcomeStatus: "OVERDUE",
  lastRunId: "run-001",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2027-01-01T12:10:00.000Z",
  closedAt: "2027-01-01T12:10:00.000Z",
  closedReason: "CYCLE_ROLLED_OVER",
  closedBy: null,
  cycleEnded: true,
  exclusionReason: null,
  waiverExpiresAt: null,
  waiverExpired: false,
  evidenceJson: { expressionResults: [] },
  outcomeStatus: "OVERDUE",
  outcomeSummary: "Measure outcome is overdue and requires follow-up.",
  outcomeEvaluatedAt: "2026-12-31T12:00:00.000Z",
  latestOutreachDeliveryStatus: null,
  timeline: [],
};

let detail: Record<string, unknown> = ROLLED_OVER;
const caseReads = () => get.mock.calls.filter(([url]) => url === "/api/cases/case-001").length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2027, 0, 15, 10));
  setPublicDemo(false);
  setSubject("patient");
  detail = ROLLED_OVER;
  emitToast.mockReset();
  post.mockReset().mockImplementation(async () => detail);
  get.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/cases/case-001") return detail;
    return [];
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function open() {
  render(<CaseDetailPage />);
  await waitFor(() => expect(screen.getAllByText("Lisa Carter").length).toBeGreaterThan(0));
}

describe("a case the new year closed (#882)", () => {
  it("says the year ended in its next action, where the gap's work used to be", async () => {
    await open();
    expect(
      screen.getByText(
        "2026 has ended, so this gap closed when 2027 began. A re-check records the 2026 result here and leaves the case closed. This patient's 2027 gaps are on the work list.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Order a mammogram")).toBeNull();
  });

  it("names the year the work list shows: the current one for an older case, the next one ahead of the calendar", async () => {
    detail = { ...ROLLED_OVER, evaluationPeriod: "2025-01-01" };
    await open();
    expect(screen.getByText(/This patient's 2027 gaps are on the work list\.$/)).toBeInTheDocument();
    cleanup();
    // A rehearsal on a copy rolls 2026 over in December, before the calendar does.
    vi.setSystemTime(new Date(2026, 11, 10, 10));
    detail = ROLLED_OVER;
    await open();
    expect(screen.getByText(/closed when 2027 began\. .* This patient's 2027 gaps are on the work list\.$/)).toBeInTheDocument();
  });

  it("names the closed reason in words", async () => {
    await open();
    const reason = screen.getByText("Closed reason").nextElementSibling;
    expect(reason).toHaveTextContent("The measurement year ended");
    expect(screen.queryByText("CYCLE_ROLLED_OVER")).toBeNull();
  });

  it("offers no outreach, and says why", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Preview outreach" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send outreach" })).toBeDisabled();
    expect(screen.getByTestId("outreach-hint")).toHaveTextContent("2026 has ended and this case is closed, so it takes no outreach.");
  });

  it("a re-check says the year's result is recorded and the case stays closed", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Rerun to verify" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/cases/case-001/rerun-to-verify"));
    await waitFor(() => expect(emitToast).toHaveBeenCalledWith("Re-checked: the 2026 result is recorded; the case stays closed."));
  });
});

describe("a closed case of the current year is unchanged", () => {
  const CURRENT = { ...ROLLED_OVER, evaluationPeriod: "2027-01-01", closedReason: "AUTO_RESOLVED", currentOutcomeStatus: "COMPLIANT", cycleEnded: false };

  it("keeps outreach, its own next action and the usual re-check toast", async () => {
    detail = CURRENT;
    await open();
    expect(screen.getByRole("button", { name: "Preview outreach" })).toBeEnabled();
    expect(screen.getByTestId("outreach-hint")).toHaveTextContent("Preview the outreach message before sending.");
    expect(screen.getByText("Order a mammogram")).toBeInTheDocument();
    expect(screen.getByText("Closed reason").nextElementSibling).toHaveTextContent("AUTO_RESOLVED");
    fireEvent.click(screen.getByRole("button", { name: "Rerun to verify" }));
    await waitFor(() => expect(emitToast).toHaveBeenCalledWith("Case rerun verification completed"));
  });

  it("the server's rule decides, not the calendar: a closed case of an older year whose cycle is still running keeps outreach", async () => {
    // A three-year cycle anchored in 2026 is current in 2027.
    detail = { ...ROLLED_OVER, closedReason: "AUTO_RESOLVED", cycleEnded: false };
    await open();
    expect(screen.getByRole("button", { name: "Preview outreach" })).toBeEnabled();
    expect(screen.getByText("Order a mammogram")).toBeInTheDocument();
  });

  it("an earlier year's case still open (before the year's first nightly) keeps outreach too", async () => {
    detail = { ...ROLLED_OVER, status: "OPEN", closedAt: null, closedReason: null };
    await open();
    expect(screen.getByRole("button", { name: "Preview outreach" })).toBeEnabled();
    expect(screen.getByTestId("outreach-hint")).toHaveTextContent("Preview the outreach message before sending.");
  });
});

describe("a period that is not a calendar year", () => {
  it("is said in words, with no year the period does not have", async () => {
    detail = { ...ROLLED_OVER, measureId: "flu_vaccine", evaluationPeriod: "2026-07-01" };
    await open();
    expect(
      screen.getByText(
        "This measurement period has ended, so this gap closed when the next one began. A re-check records that period's result here and leaves the case closed. This patient's current gaps are on the work list.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("outreach-hint")).toHaveTextContent("Its measurement period has ended and this case is closed, so it takes no outreach.");
  });
});

describe("the server's refusal of outreach on a closed case of an ended year", () => {
  it("is shown in its own words, and the case is read again as it now is", async () => {
    // The page was opened on 31 December; the case closed overnight.
    detail = { ...ROLLED_OVER, status: "OPEN", closedAt: null, closedReason: null };
    const refusal = "This case closed when 2026 ended; it takes no outreach.";
    get.mockImplementation(async (url: string) => {
      if (url === "/api/cases/case-001") return detail;
      if (url.startsWith("/api/cases/case-001/actions/outreach/preview")) {
        throw new ApiError(
          409,
          JSON.stringify({ error: "earlier_cycle_closed", message: refusal, id: "case-001", evaluationPeriod: "2026-01-01" }),
          "Request failed (409)",
        );
      }
      return [];
    });
    await open();
    const reads = caseReads();
    detail = ROLLED_OVER;
    fireEvent.click(screen.getByRole("button", { name: "Preview outreach" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.queryByText(/Request failed/)).toBeNull();
    await waitFor(() => expect(caseReads()).toBe(reads + 1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview outreach" })).toBeDisabled());
  });
});
