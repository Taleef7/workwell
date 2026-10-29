/**
 * Acting from the patient page (#868): one message for the ticked gaps, the last contact per gap, and a
 * re-check per gap. The pilot group's staff asked to contact a patient once about every gap, from the page
 * where they see that patient, instead of opening each case and sending one message per gap.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import EmployeeProfilePage from "../page";
import { ApiError } from "@/lib/api/errors";
import { SENSITIVE_MEASURES } from "@/lib/sensitive-measures";

const get = vi.fn();
const post = vi.fn();
const apiMock = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const emitToast = vi.fn();
vi.mock("@/lib/toast", () => ({ emitToast: (...args: unknown[]) => emitToast(...args) }));

const ROLE = vi.hoisted(() => ({ current: "ROLE_CASE_MANAGER" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: ROLE.current, email: "quality-staff@maui.workwell.dev" } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ externalId: "maui-pat-00001" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/features/employee/components/IndividualComplianceStatus", () => ({
  IndividualComplianceStatus: () => <div />,
}));
vi.mock("@/features/employee/components/SimulateComplianceHistory", () => ({
  SimulateComplianceHistory: () => <div />,
}));

const gap = (caseId: string, measureId: string, measureName: string, extra: Record<string, unknown> = {}) => ({
  caseId, measureId, measureName, outcomeStatus: "OVERDUE", priority: "HIGH", assignee: null, slaDueDate: null,
  lastOutreachAt: null, lastOutreachBy: null, lastOutreachChannel: null, lastOutreachDeliveryStatus: null, ...extra,
});

const profile = {
  id: "maui-pat-00001",
  externalId: "maui-pat-00001",
  name: "Lisa Carter",
  role: "Patient",
  site: "Wailuku",
  supervisorName: null,
  startDate: null,
  fhirPatientId: null,
  active: true,
  measureOutcomes: [],
  openCases: [
    gap("case-1", "cms125", "Breast Cancer Screening"),
    gap("case-2", "cms122", "Diabetes HbA1c", {
      lastOutreachAt: "2026-10-22T15:00:00.000Z",
      lastOutreachBy: "quality-staff@maui.workwell.dev",
      lastOutreachChannel: "EMAIL",
      lastOutreachDeliveryStatus: "SIMULATED",
    }),
    gap("case-3", "cms2", "Depression Screening"),
  ],
  recentAuditEvents: [],
};

const PREVIEW = { dryRun: true, messages: [{ caseIds: ["case-1", "case-2"], subject: "A reminder from your clinic", bodyText: "Hello Lisa, our records show you are due for a mammogram and an A1c blood test." }] };

const profileReads = () => get.mock.calls.filter(([url]) => url === "/api/employees/maui-pat-00001/profile").length;
const sendButton = () => screen.getByRole("button", { name: /^Send one message about/ });

beforeEach(() => {
  setSubject("patient");
  ROLE.current = "ROLE_CASE_MANAGER";
  emitToast.mockReset();
  post.mockReset().mockImplementation((url: string, body?: { dryRun?: boolean; caseIds?: string[] }) => {
    if (url === "/api/cases/patient-outreach") {
      return Promise.resolve(body?.dryRun ? PREVIEW : { dryRun: false, messages: 1, unrecorded: [], results: [] });
    }
    return Promise.resolve({ status: "OPEN" });
  });
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/employees/maui-pat-00001/profile") return Promise.resolve(profile);
    return Promise.resolve([]);
  });
});

describe("one message for the ticked gaps", () => {
  it("ticks every gap but CMS2 and CMS137, and says why the sensitive one is left out", async () => {
    render(<EmployeeProfilePage />);
    const boxes = await screen.findAllByRole("checkbox", { name: /in the message/ });
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, true, false]);
    expect(screen.getAllByTestId("sensitive-note")).toHaveLength(1);
    expect(screen.getByText(/One message about the 2 ticked gaps/)).toBeInTheDocument();
  });

  it("sends nothing until the current choice is previewed, and a change after the preview clears it", async () => {
    render(<EmployeeProfilePage />);
    await screen.findAllByRole("checkbox", { name: /in the message/ });
    expect(sendButton()).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Preview message" }));
    await waitFor(() => expect(screen.getByTestId("gap-outreach-preview")).toHaveTextContent("a mammogram and an A1c blood test"));
    expect(post).toHaveBeenLastCalledWith("/api/cases/patient-outreach", { caseIds: ["case-1", "case-2"], channel: "EMAIL", dryRun: true });
    expect(sendButton()).toBeEnabled();

    // Ticking the depression gap changes what would be sent, so the preview no longer stands.
    await userEvent.click(screen.getAllByRole("checkbox", { name: /in the message/ })[2]!);
    expect(screen.queryByTestId("gap-outreach-preview")).toBeNull();
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveTextContent("Send one message about 3 gaps");

    await userEvent.click(screen.getByRole("button", { name: "Preview message" }));
    await waitFor(() => expect(sendButton()).toBeEnabled());
    const readsBefore = profileReads();
    await userEvent.click(sendButton());
    await waitFor(() => expect(emitToast).toHaveBeenCalledWith("Message sent", "success"));
    const sends = post.mock.calls.filter(([url, body]) => url === "/api/cases/patient-outreach" && !body?.dryRun);
    expect(sends).toEqual([["/api/cases/patient-outreach", { caseIds: ["case-1", "case-2", "case-3"], channel: "EMAIL" }]]);
    await waitFor(() => expect(profileReads()).toBeGreaterThan(readsBefore));
  });

  it("a changed channel clears the preview too, and a text's preview has no subject", async () => {
    render(<EmployeeProfilePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Preview message" }));
    await waitFor(() => expect(sendButton()).toBeEnabled());
    expect(screen.getByTestId("gap-outreach-preview")).toHaveTextContent("Subject: A reminder from your clinic");
    await userEvent.click(screen.getByRole("combobox", { name: "Channel" }));
    await userEvent.click(await screen.findByRole("option", { name: "SMS" }));
    expect(sendButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Preview message" }));
    await waitFor(() => expect(sendButton()).toBeEnabled());
    expect(screen.getByTestId("gap-outreach-preview")).not.toHaveTextContent("Subject:");
  });

  it("a per-gap send that failed says it may still have gone out, and the toast counts only the sent ones", async () => {
    setSubject("employee");
    post.mockImplementation((_url: string, body?: { dryRun?: boolean }) =>
      Promise.resolve(body?.dryRun ? PREVIEW : { dryRun: false, messages: 1, unrecorded: [], failed: ["case-2"], results: [] }),
    );
    render(<EmployeeProfilePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Preview message" }));
    const send = screen.getByRole("button", { name: /^Send \d+ messages?$/ });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    const warning = await screen.findByTestId("gap-outreach-failed");
    expect(warning).toHaveTextContent(/may still have\s+gone out/);
    expect(warning).toHaveTextContent(/cms122|Diabetes HbA1c/i);
    expect(screen.queryByTestId("gap-outreach-unrecorded")).toBeNull();
    expect(emitToast).toHaveBeenCalledWith("Message sent", "success");
  });

  it("names the gaps whose record of a sent message failed", async () => {
    post.mockImplementation((_url: string, body?: { dryRun?: boolean }) =>
      Promise.resolve(body?.dryRun ? PREVIEW : { dryRun: false, messages: 1, unrecorded: ["case-2"], results: [] }),
    );
    render(<EmployeeProfilePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Preview message" }));
    await waitFor(() => expect(sendButton()).toBeEnabled());
    await userEvent.click(sendButton());
    const warning = await screen.findByTestId("gap-outreach-unrecorded");
    expect(warning).toHaveTextContent(/no record of it/);
    expect(warning).toHaveTextContent(/cms122|Diabetes HbA1c/i);
    expect(warning).not.toHaveTextContent(/cms125|Breast Cancer/i);
  });

  it("a stale page's refusal is shown with a way to reload", async () => {
    post.mockRejectedValue(new ApiError(409, "{}", "A chosen gap is no longer open (RESOLVED). Reload the page."));
    render(<EmployeeProfilePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Preview message" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("no longer open");
    const readsBefore = profileReads();
    await userEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(profileReads()).toBeGreaterThan(readsBefore));
  });

  it("the patient page's sensitive measures are the server's", () => {
    const server = readFileSync(resolve(__dirname, "../../../../../../backend-ts/src/case/care-item.ts"), "utf8");
    const declared = server.match(/SENSITIVE_MEASURES[^=]*=\s*new Set\(\[([^\]]*)\]\)/)?.[1];
    expect(declared).toBeDefined();
    const ids = [...declared!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(SENSITIVE_MEASURES));
  });
});

describe("the last contact and a re-check, per gap", () => {
  it("says when each gap was last contacted, how and by whom, or that it never was", async () => {
    render(<EmployeeProfilePage />);
    const lines = await screen.findAllByTestId("last-contact");
    expect(lines.map((l) => l.textContent)).toEqual([
      "Not contacted yet",
      "Emailed Oct 22, 2026 by quality-staff@maui.workwell.dev · simulated",
      "Not contacted yet",
    ]);
  });

  it("re-checks THAT gap and re-reads the page; a failure stays on its row", async () => {
    render(<EmployeeProfilePage />);
    const buttons = await screen.findAllByRole("button", { name: /^Re-check:/ });
    const readsBefore = profileReads();
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/cases/case-1/rerun-to-verify"));
    await waitFor(() => expect(emitToast).toHaveBeenCalledWith(expect.stringContaining("still open after re-check"), "success"));
    await waitFor(() => expect(profileReads()).toBeGreaterThan(readsBefore));

    post.mockRejectedValueOnce(new ApiError(500, "{}", "Verification failed; the case is unchanged."));
    await userEvent.click(screen.getAllByRole("button", { name: /^Re-check:/ })[1]!);
    expect(await screen.findByText("Verification failed; the case is unchanged.")).toBeInTheDocument();
    expect(post).toHaveBeenLastCalledWith("/api/cases/case-2/rerun-to-verify");
  });

  it("a viewer sees the last contact but no way to message or re-check", async () => {
    ROLE.current = "ROLE_VIEWER";
    render(<EmployeeProfilePage />);
    await screen.findByText("Lisa Carter");
    expect(await screen.findAllByTestId("last-contact")).toHaveLength(3);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByTestId("gap-outreach")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Re-check:/ })).toHaveLength(0);
  });
});
