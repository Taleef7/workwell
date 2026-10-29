/**
 * The patient page leads with the work (#865).
 *
 * The practice's quality staff open a patient to act on their gaps. The page put the evidence and a
 * simulation card above the gaps, the way into a case was the measure name (not read as a link), and
 * nothing said when a gap had been assigned. These pin the order, the button, the assigned line, and
 * that the evidence starts folded for staff and open for the engineering seat.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get, post: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const ROLE = vi.hoisted(() => ({ current: "ROLE_CASE_MANAGER" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: ROLE.current, email: "quality-staff@maui.workwell.dev" } }),
}));
// The pilot rule (`NEXT_PUBLIC_PUBLIC_DEMO=off`): only the admin seat sees engineering surfaces. Tests run
// with the demo default, where everyone does, so the rule is stated here.
vi.mock("@/lib/public-demo", () => ({
  canSeeEngineering: (role: string | null | undefined) => role === "ROLE_ADMIN",
  isPilotMode: () => true,
  PUBLIC_DEMO: false,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ externalId: "pat-003" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/features/employee/components/IndividualComplianceStatus", () => ({
  IndividualComplianceStatus: () => <div data-testid="individual-compliance-status" />,
}));
vi.mock("@/features/employee/components/SimulateComplianceHistory", () => ({
  SimulateComplianceHistory: () => <div data-testid="simulate-compliance-history" />,
}));

import EmployeeProfilePage from "../page";

const gap = (over: Record<string, unknown>) => ({
  measureName: "Breast Cancer Screening",
  measureId: "cms125",
  outcomeStatus: "OVERDUE",
  priority: "HIGH",
  assignee: "quality-staff@maui.workwell.dev",
  slaDueDate: null,
  assignedAt: null,
  assignedBy: null,
  assignedVia: null,
  ...over,
});

const profile = {
  id: "pat-003",
  externalId: "pat-003",
  name: "Milo Quade",
  role: "Patient",
  site: "Wailuku",
  supervisorName: null,
  startDate: null,
  fhirPatientId: null,
  active: true,
  measureOutcomes: [
    { measureId: "cms125", measureVersionId: "cms125", measureName: "Breast Cancer Screening", measureVersion: "", outcomeStatus: "OVERDUE", lastRunDate: "2026-10-01T00:00:00Z", daysSinceLastExam: null, daysUntilDue: null, openCaseId: "case-1" },
  ],
  openCases: [
    gap({ caseId: "case-1", assignedAt: "2026-10-22T15:00:00.000Z", assignedBy: "quality-lead@maui.workwell.dev", assignedVia: "OPERATOR" }),
    gap({ caseId: "case-2", measureId: "cms122", measureName: "Diabetes", assignedAt: "2026-10-03T12:00:00.000Z", assignedVia: "PANEL" }),
    gap({ caseId: "case-3", measureId: "cms130", measureName: "Colorectal", assignedAt: "2026-10-20T12:00:00.000Z", assignedBy: "quality-lead@maui.workwell.dev", assignedVia: "BULK" }),
    // The server could not say: no line, rather than a guessed one.
    gap({ caseId: "case-4", measureId: "cms2", measureName: "Depression" }),
  ],
  recentAuditEvents: [],
};

function serve(p: unknown) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/employees/pat-003/profile") return Promise.resolve(p);
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  setSubject("patient");
  ROLE.current = "ROLE_CASE_MANAGER";
  serve(profile);
});

describe("the patient page leads with the work", () => {
  it("puts Open Cases first, then Measure Details, then the folded evidence and simulation", async () => {
    render(<EmployeeProfilePage />);
    const open = await screen.findByTestId("open-cases");
    const details = screen.getByRole("heading", { name: "Measure Details" });
    const evidence = screen.getByTestId("evidence-disclosure");
    const simulation = screen.getByTestId("simulation-disclosure");
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(open, details)).toBe(true);
    expect(follows(details, evidence)).toBe(true);
    expect(follows(evidence, simulation)).toBe(true);
  });

  it("gives every gap an Open case button to its case", async () => {
    render(<EmployeeProfilePage />);
    const buttons = await screen.findAllByRole("link", { name: /^Open case:/ });
    expect(buttons.map((b) => b.getAttribute("href"))).toEqual(["/cases/case-1", "/cases/case-2", "/cases/case-3", "/cases/case-4"]);
    expect(buttons[0]).toHaveTextContent("Open case →");
  });

  it("says when and how each gap reached its assignee, and nothing where the server could not say", async () => {
    render(<EmployeeProfilePage />);
    const table = within(await screen.findByTestId("open-cases"));
    const lines = table.getAllByTestId("assigned-line").map((l) => l.textContent);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Assigned Oct 2[12], 2026 by quality-lead@maui\.workwell\.dev$/);
    expect(lines[1]).toMatch(/^From the provider's panel, Oct [23], 2026$/);
    expect(lines[2]).toMatch(/^Assigned Oct (19|20), 2026 by quality-lead@maui\.workwell\.dev \(bulk\)$/);
  });

  it("folds the evidence and the simulation for staff, and opens them for the engineering seat", async () => {
    const { unmount } = render(<EmployeeProfilePage />);
    expect(await screen.findByTestId("evidence-disclosure")).not.toHaveAttribute("open");
    expect(screen.getByTestId("simulation-disclosure")).not.toHaveAttribute("open");
    // Folded, not removed: the card is still there for someone who opens it.
    expect(screen.getByTestId("individual-compliance-status")).toBeInTheDocument();
    unmount();

    ROLE.current = "ROLE_ADMIN";
    render(<EmployeeProfilePage />);
    expect(await screen.findByTestId("evidence-disclosure")).toHaveAttribute("open");
    expect(screen.getByTestId("simulation-disclosure")).toHaveAttribute("open");
  });

  it("keeps the Open Cases heading with a plain line when there are none", async () => {
    serve({ ...profile, openCases: [] });
    render(<EmployeeProfilePage />);
    const open = await screen.findByTestId("open-cases");
    expect(within(open).getByText("No open cases.")).toBeInTheDocument();
  });
});
