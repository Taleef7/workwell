/**
 * The case page's "Why this was flagged" and "Other open gaps" (#880): what the measure's CQL found for
 * the gap (the list report's own reading, `cqlFindings`), and what else the patient is due for.
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

const findings = async () => screen.findByTestId("cql-findings");

describe("Why this was flagged: what the measure's CQL found (#880)", () => {
  it("puts the date first, then every value by the define that computed it, and names the logic", async () => {
    detail = caseDetail({
      cqlFindings: {
        status: "LATEST_NOT_QUALIFYING",
        rate: null,
        date: "2026-03-22",
        dateLabel: "Most Recent Blood Pressure Day",
        executedLogic: "CMS165FHIR v1.0.000",
        values: [
          { label: "Most Recent Blood Pressure Day", value: "2026-03-22" },
          { label: "Lowest Systolic Reading on Most Recent Blood Pressure Day", value: "152 'mm[Hg]'" },
        ],
      },
    });
    render(<CaseDetailPage />);
    const box = await findings();
    expect(box).toHaveTextContent("Latest found: 2026-03-22, Most Recent Blood Pressure Day");
    expect(within(box).getByText("Lowest Systolic Reading on Most Recent Blood Pressure Day")).toBeInTheDocument();
    expect(within(box).getByText("152 'mm[Hg]'")).toBeInTheDocument();
    expect(box).toHaveTextContent("Computed by CMS165FHIR v1.0.000.");
    expect(screen.getByRole("heading", { name: "Why this was flagged" })).toBeInTheDocument();
  });

  it("says nothing was found when CQL found nothing it looks for", async () => {
    detail = caseDetail({ cqlFindings: { status: "NONE_FOUND", rate: null, date: null, dateLabel: null, executedLogic: "CMS122FHIR v1.0.000", values: [] } });
    render(<CaseDetailPage />);
    expect(await findings()).toHaveTextContent("Nothing found that meets the measure.");
  });

  it("on none found, still shows what CQL did record: why the patient is in the measure", async () => {
    detail = caseDetail({
      cqlFindings: {
        status: "NONE_FOUND",
        rate: "Initiation",
        date: null,
        dateLabel: null,
        executedLogic: "CMS137FHIR v1.0.000",
        values: [{ label: "First SUD Episode During Measurement Period", value: "Encounter/e1 {status=finished}" }],
      },
    });
    render(<CaseDetailPage />);
    const box = await findings();
    expect(box).toHaveTextContent("Nothing found that meets the measure.");
    expect(within(box).getByText("First SUD Episode During Measurement Period")).toBeInTheDocument();
  });

  it("says the logic does not report its result, and names the rate on a multi-rate measure", async () => {
    detail = caseDetail({ cqlFindings: { status: "NOT_EXPOSED_BY_LOGIC", rate: "Engagement", date: null, dateLabel: null, executedLogic: null, values: [] } });
    render(<CaseDetailPage />);
    const box = await findings();
    expect(box).toHaveTextContent("What the measure found · Engagement");
    expect(box).toHaveTextContent("This measure's logic doesn't report which result it found.");
  });

  it.each(["NOT_RECORDED_BY_RUN", "NOT_APPLICABLE"])("shows nothing on %s, rather than a claim about the chart", async (status) => {
    detail = caseDetail({ cqlFindings: { status, rate: null, date: null, dateLabel: null, executedLogic: null, values: [] } });
    render(<CaseDetailPage />);
    await screen.findByRole("heading", { name: "Why this was flagged" });
    expect(screen.queryByTestId("cql-findings")).toBeNull();
    expect(screen.queryByText(/Nothing found/)).toBeNull();
  });

  it("folds an official outcome's population flags under Measure populations", async () => {
    render(<CaseDetailPage />);
    const summary = await screen.findByText("Measure populations");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });
});

describe("Other open gaps for this patient (#880)", () => {
  it("lists the patient's other gaps, not this one, and offers one message about them", async () => {
    render(<CaseDetailPage />);
    const panel = await screen.findByTestId("other-open-gaps");
    await within(panel).findByText("Diabetes: HbA1c Poor Control");
    expect(within(panel).queryByText("Controlling High Blood Pressure")).toBeNull();
    expect(within(panel).getByRole("link", { name: "Open case →" })).toHaveAttribute("href", "/cases/case-002");
    expect(within(panel).getByText("Not contacted yet")).toBeInTheDocument();
    // Never "all N": the patient page leaves CMS2 and CMS137 unticked until a person chooses them (#868).
    expect(within(panel).getByRole("link", { name: "Message the patient about their gaps →" })).toHaveAttribute(
      "href",
      "/patients/maui-pat-00006#open-cases",
    );
    expect(within(panel).queryByRole("link", { name: /all \d+ gaps/ })).toBeNull();
  });

  it("says when this is the patient's only gap", async () => {
    openCases = { openCases: [gap("case-001", "cms165", "Controlling High Blood Pressure")] };
    render(<CaseDetailPage />);
    expect(await screen.findByText("No other open gaps for this patient.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Message about all/ })).toBeNull();
  });

  it.each([
    ["a failed read", new Error("boom")],
    ["an answer it does not understand", []],
  ])("says so on %s, never that there are none", async (_, answer) => {
    openCases = answer;
    render(<CaseDetailPage />);
    expect(await screen.findByText("The patient's other open gaps could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText(/No other open gaps/)).toBeNull();
  });

  it("offers a read-only seat the list but not the message", async () => {
    auth.role = "ROLE_VIEWER";
    render(<CaseDetailPage />);
    const panel = await screen.findByTestId("other-open-gaps");
    await within(panel).findByText("Diabetes: HbA1c Poor Control");
    expect(within(panel).queryByRole("link", { name: /Message about all/ })).toBeNull();
  });
});

describe("Moving to another case", () => {
  it("starts the next case fresh: nothing from the previous one carries over", async () => {
    post.mockResolvedValue({ explanation: "Explained for case-001.", disclaimer: "AI-assisted." });
    const view = render(<CaseDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Explain Why Flagged" }));
    expect(await screen.findByText("Explained for case-001.")).toBeInTheDocument();

    route.id = "case-002";
    view.rerender(<CaseDetailPage />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/cases/case-002"));
    expect(screen.queryByText("Explained for case-001.")).toBeNull();
  });
});
