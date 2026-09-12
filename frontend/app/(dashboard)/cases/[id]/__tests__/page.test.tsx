import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

let currentRole = "ROLE_ADMIN";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole }, token: "test-token", updateToken: () => {} }),
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
    currentRole = "ROLE_ADMIN";
    get.mockClear();
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
      if (url === "/api/users/assignable") {
        return Promise.resolve([
          { email: "admin@maui.workwell.dev", role: "ROLE_ADMIN" },
          { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
        ]);
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

  it("offers the assignable accounts from the profile as options", async () => {
    render(<CaseDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Actions")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Actions"));
    const control = (await screen.findAllByRole("combobox", { name: /assignee/i }))[0]!;
    fireEvent.click(control);
    await waitFor(() => {
      const offered = screen.getAllByRole("option").map((option) => option.textContent?.trim());
      // EXACT and ordered, not "contains": this is the only frontend test pinning #520's profile
      // isolation, and the same list is now what the server accepts — a leaked `@workwell.dev`
      // account would be both offered and assignable.
      expect(offered).toEqual([
        "Choose an assignee…",
        "admin@maui.workwell.dev",
        "quality-lead@maui.workwell.dev",
        "Unassign",
      ]);
    });
    // The free-text box it replaced is gone: nothing on the page invites an email nobody can verify.
    expect(screen.queryByPlaceholderText("Type or pick an email")).not.toBeInTheDocument();
    expect(document.querySelector("#case-assignees")).not.toBeInTheDocument();
  });

  /**
   * The route only began canonicalizing the assignee's spelling in this change; every row written
   * before it carries whatever the free-text box sent. The control matches option values exactly, so
   * a stored `Quality-Lead@Maui.WorkWell.dev` matches no option built from the account's own
   * spelling — and the Select falls back to its placeholder over a case that IS assigned. Reported by
   * the PR bot after two reviews had looked at this line.
   */
  it("shows a legacy mixed-case assignee as the account it is, not as an empty control", async () => {
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => {
      const result = await base(url);
      return url.startsWith("/api/cases/case-001") && result && typeof result === "object" && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), assignee: "Quality-Lead@Maui.WorkWell.dev" }
        : result;
    });

    render(<CaseDetailPage />);
    await waitFor(() => expect(screen.getByText("Actions")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Actions"));

    const control = (await screen.findAllByRole("combobox", { name: /assignee/i }))[0]!;
    await waitFor(() => expect(control).toHaveTextContent("quality-lead@maui.workwell.dev"));
    expect(control).not.toHaveTextContent("Choose an assignee");
    // And it is the live account, not a second entry shadowing it.
    expect(screen.queryByText(/no longer assignable/i)).not.toBeInTheDocument();
  });

  it("viewer role does not request /api/users/assignable", async () => {
    currentRole = "ROLE_VIEWER";
    render(<CaseDetailPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/Breast Cancer Screening/i).length).toBeGreaterThan(0);
    });
    const assignableCalls = get.mock.calls.filter(([url]) => url === "/api/users/assignable");
    expect(assignableCalls).toHaveLength(0);
  });

  it("still offers the assignee control on a closed case", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([]);
      }
      if (url === "/api/cases/case-001") {
        return Promise.resolve({
          caseId: "case-001",
          employeeId: "emp-101",
          employeeName: "Alice Walker",
          measureId: "cms125",
          measureVersionId: "cms125",
          measureName: "Breast Cancer Screening",
          measureVersion: "1.0",
          evaluationPeriod: "2026-Q1",
          status: "CLOSED",
          priority: "HIGH",
          assignee: "admin@maui.workwell.dev",
          nextAction: "None",
          currentOutcomeStatus: "COMPLIANT",
          lastRunId: "run-001",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          closedAt: "2026-01-02T00:00:00.000Z",
          closedReason: "Resolved",
          closedBy: "admin@maui.workwell.dev",
          exclusionReason: null,
          waiverExpiresAt: null,
          waiverExpired: false,
          evidenceJson: { expressionResults: [] },
          outcomeStatus: "COMPLIANT",
          outcomeSummary: "Case is closed",
          outcomeEvaluatedAt: "2026-01-01T00:00:00.000Z",
          latestOutreachDeliveryStatus: null,
          timeline: [],
        });
      }
      return Promise.resolve([]);
    });

    render(<CaseDetailPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Closed").length).toBeGreaterThan(0);
    });
    expect((await screen.findAllByRole("combobox", { name: /assignee/i })).length).toBeGreaterThan(0);
  });

  /**
   * ADR-076 d2 made an operator's next action outrank the nightly wording. That rule is invisible on
   * the case page unless the page says so: after escalating, an operator cannot otherwise tell that
   * their instruction will survive the next run, nor that the outcome changing hands it back. The
   * system-owned default stays silent — a badge on every case is furniture, not information.
   *
   * Both tests DELEGATE to the suite's default mock and patch only the case payload, so the page still
   * receives the measures and timeline it needs to render at all. Replacing the whole implementation
   * rendered an empty page and made the negative test pass for the wrong reason.
   */
  function withCaseOverrides(overrides: Record<string, unknown>) {
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => {
      const result = await base(url);
      return url.startsWith("/api/cases/case-001") && result && typeof result === "object" && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), ...overrides }
        : result;
    });
  }

  it("says when the next action was written by a person", async () => {
    withCaseOverrides({ nextAction: "Call the patient; evenings only.", nextActionSource: "OPERATOR" });
    render(<CaseDetailPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Call the patient; evenings only.").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/Written by a person/i)).toBeInTheDocument();
  });

  it("shows no owner note for a system-written next action", async () => {
    withCaseOverrides({ nextActionSource: "SYSTEM" });
    render(<CaseDetailPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Schedule screening appointment").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Written by a person/i)).not.toBeInTheDocument();
  });

  /** The audit-timeline panel, so "Created" here cannot match the case's own Created date elsewhere. */
  function timelinePanel(): HTMLElement {
    return screen.getByText("Audit timeline").closest("div")!.parentElement as HTMLElement;
  }

  it("opens with the audit timeline collapsed to the newest entry, and nothing is removed", async () => {
    // The staff ask: on a case with a long history the ledger pushed the next action and the outreach
    // controls below the fold. Collapsed is a RENDERING choice — every state change is still audited
    // and still reachable, which is why the control counts what it is hiding.
    withCaseOverrides({
      timeline: [
        { eventType: "CASE_ASSIGNED", occurredAt: "2026-03-03T00:00:00.000Z", actor: "cm@workwell.dev", payload: {} },
        { eventType: "OUTREACH_SENT", occurredAt: "2026-02-02T00:00:00.000Z", actor: "cm@workwell.dev", payload: {} },
        { eventType: "CASE_CREATED", occurredAt: "2026-01-01T00:00:00.000Z", actor: "system", payload: {} },
      ],
    });
    render(<CaseDetailPage />);

    const toggle = await screen.findByRole("button", { name: /show history \(2 more\)/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The newest entry stays visible, so the page still says when something last happened.
    expect(within(timelinePanel()).getByText("Assigned")).toBeInTheDocument();
    expect(within(timelinePanel()).queryByText("Created")).not.toBeInTheDocument();
    expect(within(timelinePanel()).queryByText("Outreach Sent")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(await within(timelinePanel()).findByText("Created")).toBeInTheDocument();
    expect(within(timelinePanel()).getByText("Outreach Sent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hide history/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("offers no history control when there is nothing to hide", async () => {
    withCaseOverrides({
      timeline: [{ eventType: "CASE_CREATED", occurredAt: "2026-01-01T00:00:00.000Z", actor: "system", payload: {} }],
    });
    render(<CaseDetailPage />);
    await waitFor(() => expect(within(timelinePanel()).getByText("Created")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /show history/i })).not.toBeInTheDocument();
  });
});
