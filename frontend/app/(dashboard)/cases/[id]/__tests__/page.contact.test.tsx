/**
 * The case page's Log contact and channel picker (#886): a contact staff made themselves, recorded on this gap
 * and, by default, the patient's other open gaps; and the outreach picker opening on the patient's preference.
 */
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const post = vi.fn();
const apiMock = { get, post, patch: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const route = vi.hoisted(() => ({ id: "case-001" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: route.id }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const auth = vi.hoisted(() => ({ role: "ROLE_QUALITY_STAFF" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: auth.role, email: "quality-staff@maui.workwell.dev" }, token: "t", updateToken: () => {} }),
}));

import CaseDetailPage from "../page";

const caseDetail = (overrides: Record<string, unknown> = {}) => ({
  caseId: "case-001",
  employeeId: "maui-pat-00006",
  employeeName: "Alice Walker",
  measureId: "cms165",
  measureVersionId: "cms165",
  measureName: "Controlling High Blood Pressure",
  measureVersion: "1.0",
  evaluationPeriod: "2026-01-01",
  status: "OPEN",
  priority: "HIGH",
  assignee: "quality-staff@maui.workwell.dev",
  nextAction: "Recheck blood pressure",
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
  evidenceJson: {
    expressionResults: [
      { define: "official:initial-population", result: true },
      { define: "official:numerator", result: false },
    ],
  },
  outcomeStatus: "OVERDUE",
  outcomeSummary: "Blood pressure not controlled.",
  outcomeEvaluatedAt: "2026-03-23T00:00:00.000Z",
  latestOutreachDeliveryStatus: null,
  timeline: [],
  ...overrides,
});

const gap = (caseId: string, measureId: string, measureName: string, extra: Record<string, unknown> = {}) => ({
  caseId,
  measureId,
  measureName,
  outcomeStatus: "OVERDUE",
  priority: "HIGH",
  assignee: null,
  lastOutreachAt: null,
  slaDueDate: null,
  slaRemainingDays: null,
  slaBreached: false,
  ...extra,
});

let detail = caseDetail();
let openCases: unknown = { openCases: [gap("case-001", "cms165", "Controlling High Blood Pressure"), gap("case-002", "cms122", "Diabetes: HbA1c Poor Control")] };

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_QUALITY_STAFF";
  route.id = "case-001";
  detail = caseDetail();
  openCases = { openCases: [gap("case-001", "cms165", "Controlling High Blood Pressure"), gap("case-002", "cms122", "Diabetes: HbA1c Poor Control")] };
  post.mockReset();
  get.mockReset().mockImplementation((url: string) => {
    if (/^\/api\/cases\/case-\d+$/.test(url)) return Promise.resolve({ ...detail, caseId: url.split("/")[3] });
    if (url === "/api/employees/maui-pat-00006/open-cases") {
      return openCases instanceof Error ? Promise.reject(openCases) : Promise.resolve(openCases);
    }
    return Promise.resolve([]);
  });
});

const LOGGED = { logged: [{ caseId: "case-001", status: "IN_PROGRESS" }, { caseId: "case-002", status: "IN_PROGRESS" }], failed: [] };
const withPreference = (preferredChannel: string | null, declinedChannels: string[]) => {
  openCases = {
    ...(openCases as object),
    contactPreference: { subjectId: "maui-pat-00006", preferredChannel, declinedChannels, updatedBy: "x", updatedAt: "2026-11-03T00:00:00.000Z" },
  };
};
const otherGapShown = () => waitFor(() => expect(screen.getByText("Diabetes: HbA1c Poor Control")).toBeInTheDocument());

describe("Log contact (#886)", () => {
  it("records the call on this gap and the other open ones, sends nothing, and reads the case again", async () => {
    post.mockResolvedValue(LOGGED);
    render(<CaseDetailPage />);
    await otherGapShown();
    await userEvent.click(screen.getByRole("button", { name: "Log contact" }));
    const modal = await screen.findByTestId("log-contact");
    expect(within(modal).getByRole("checkbox", { name: /other open gap/ })).toBeChecked();
    await userEvent.type(within(modal).getByRole("textbox", { name: /Note/ }), "rang twice");
    const reads = get.mock.calls.filter(([u]) => u === "/api/cases/case-001").length;
    await userEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/cases/contact-log", {
        caseIds: ["case-001", "case-002"], channel: "PHONE", result: "NO_ANSWER", note: "rang twice",
      }),
    );
    expect(post.mock.calls.some(([u]) => String(u).includes("/actions/outreach"))).toBe(false);
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === "/api/cases/case-001").length).toBeGreaterThan(reads));
  });

  it("unticking the other gaps records this one alone", async () => {
    post.mockResolvedValue({ logged: [{ caseId: "case-001", status: "IN_PROGRESS" }], failed: [] });
    render(<CaseDetailPage />);
    await otherGapShown();
    await userEvent.click(screen.getByRole("button", { name: "Log contact" }));
    const modal = await screen.findByTestId("log-contact");
    await userEvent.click(within(modal).getByRole("checkbox", { name: /other open gap/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/cases/contact-log", { caseIds: ["case-001"], channel: "PHONE", result: "NO_ANSWER" }),
    );
  });

  it("a finished case cannot take a logged contact", async () => {
    detail = caseDetail({ status: "RESOLVED" });
    render(<CaseDetailPage />);
    expect(await screen.findByRole("button", { name: "Log contact" })).toBeDisabled();
  });

  it("warns when the channel logged is one the patient declined", async () => {
    withPreference("SMS", ["PHONE"]);
    render(<CaseDetailPage />);
    await otherGapShown();
    await userEvent.click(screen.getByRole("button", { name: "Log contact" }));
    const modal = await screen.findByTestId("log-contact");
    expect(within(modal).getByRole("note")).toHaveTextContent("asked not to be contacted this way");
  });
});

describe("the outreach picker reads the patient's preference (#886)", () => {
  it("opens on the preferred channel and the preview asks for it", async () => {
    withPreference("SMS", ["EMAIL"]);
    render(<CaseDetailPage />);
    expect(await screen.findByTestId("case-contact-preference")).toHaveTextContent("Prefers SMS · declined Email");
    await userEvent.click(screen.getByRole("button", { name: "Preview outreach" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/cases/case-001/actions/outreach/preview?channel=SMS"));
  });

  it("with every channel declined, preview and send are refused before a call", async () => {
    withPreference(null, ["EMAIL", "SMS", "PHONE"]);
    render(<CaseDetailPage />);
    expect(await screen.findByTestId("case-contact-preference")).toHaveTextContent("Declined all contact");
    expect(screen.getByRole("button", { name: "Preview outreach" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send outreach" })).toBeDisabled();
  });

  it("with no preference it opens on Email, as before", async () => {
    render(<CaseDetailPage />);
    await otherGapShown();
    await userEvent.click(screen.getByRole("button", { name: "Preview outreach" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/cases/case-001/actions/outreach/preview?channel=EMAIL"));
  });
});
