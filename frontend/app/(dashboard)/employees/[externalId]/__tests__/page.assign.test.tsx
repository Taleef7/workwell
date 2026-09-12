/**
 * Assigning a gap from the patient page (#553).
 *
 * The pilot's quality staffer could not assign at all from a list: the field was free text with no
 * suggestions, she typed her own name, and nothing happened. The work list got options; this is the
 * same control on the page where staff actually look at one person's whole picture, so a patient with
 * four gaps can be handed to one person without going back to a list.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import EmployeeProfilePage from "../page";

const get = vi.fn();
const post = vi.fn();
const apiMock = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const emitToast = vi.fn();
vi.mock("@/lib/toast", () => ({ emitToast: (...args: unknown[]) => emitToast(...args) }));

const ROLE = vi.hoisted(() => ({ current: "ROLE_CASE_MANAGER" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: ROLE.current, email: "cm@workwell.dev" } }),
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

const ASSIGNABLE = [
  { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
];

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
    {
      caseId: "case-1",
      measureId: "cms125",
      measureName: "Breast Cancer Screening",
      outcomeStatus: "OVERDUE",
      priority: "HIGH",
      assignee: null,
      slaDueDate: null,
      slaRemainingDays: null,
      slaBreached: false,
    },
    {
      caseId: "case-2",
      measureId: "cms122",
      measureName: "Diabetes HbA1c",
      outcomeStatus: "DUE_SOON",
      priority: "MEDIUM",
      // Stored in a different case than the option's value — the control must still show it as
      // assigned rather than falling back to the placeholder over a case that has an owner.
      assignee: "Quality-Staff@Maui.WorkWell.dev",
      slaDueDate: null,
      slaRemainingDays: null,
      slaBreached: false,
    },
  ],
  recentAuditEvents: [],
};

beforeEach(() => {
  setSubject("patient");
  ROLE.current = "ROLE_CASE_MANAGER";
  emitToast.mockReset();
  post.mockReset().mockResolvedValue({});
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/users/assignable")) return Promise.resolve(ASSIGNABLE);
    if (url === "/api/employees/maui-pat-00001/profile") return Promise.resolve(profile);
    return Promise.resolve([]);
  });
});

describe("assigning a gap from the patient page", () => {
  it("offers the accounts that exist and posts the chosen one for THAT gap", async () => {
    render(<EmployeeProfilePage />);
    const selects = await screen.findAllByRole("combobox", { name: "Assignee" });
    expect(selects).toHaveLength(2);

    await userEvent.click(selects[0]!);
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // The gap that was edited, not the first one on the page — a per-row control that posts the wrong
    // id is worse than no control.
    expect(String(post.mock.calls[0]![0])).toContain("/api/cases/case-1/assign");
    expect(String(post.mock.calls[0]![0])).toContain("assignee=quality-staff%40maui.workwell.dev");
    await waitFor(() => expect(emitToast).toHaveBeenCalledWith(expect.stringContaining("assigned to"), "success"));
  });

  it("shows an already-assigned gap as assigned, whatever case the address is stored in", async () => {
    render(<EmployeeProfilePage />);
    const selects = await screen.findAllByRole("combobox", { name: "Assignee" });
    // The server matches case-insensitively and an option value matches exactly, so without resolving
    // to the account's own spelling this control would render blank over an assigned case. Awaited,
    // because the resolution needs the assignable list, which arrives after the first paint.
    await waitFor(() => expect(selects[1]!).toHaveTextContent(/quality-staff@maui\.workwell\.dev/i));
  });

  it("is read-only for a viewer, who sees the owner but cannot change it", async () => {
    ROLE.current = "ROLE_VIEWER";
    render(<EmployeeProfilePage />);
    await screen.findByText("Lisa Carter");
    expect(screen.queryAllByRole("combobox", { name: "Assignee" })).toHaveLength(0);
    expect(screen.getByText("Quality-Staff@Maui.WorkWell.dev")).toBeInTheDocument();
  });
});
