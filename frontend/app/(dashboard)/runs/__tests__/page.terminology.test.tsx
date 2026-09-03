import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";

vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get, post: vi.fn(), downloadBlob: vi.fn() };
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock,
}));
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));
vi.mock("@/features/datavis/NitroGridClient", () => ({
  default: ({ columns, rows }: { columns: Array<{ field: string; header: string; visible?: boolean }>; rows: Array<Record<string, unknown>> }) => (
    <div data-testid="outcomes-grid">
      <div>{columns.filter((column) => column.visible !== false).map((column) => <span key={column.field}>{column.header}</span>)}</div>
      {rows.map((row, index) => <div key={index}>{String(row.employee)} {String(row.site)}</div>)}
    </div>
  ),
}));

import RunsPage from "../page";

const run = {
  runId: "run-1",
  measureName: "Breast Cancer Screening",
  status: "COMPLETED",
  scopeType: "MEASURE",
  triggerType: "MANUAL",
  startedAt: "2026-08-30T00:00:00Z",
  completedAt: "2026-08-30T00:01:00Z",
  durationMs: 60_000,
  totalEvaluated: 1,
  compliantCount: 0,
  nonCompliantCount: 1,
};

const summary = {
  runId: "run-1",
  measureName: "Breast Cancer Screening",
  measureVersion: "1.0",
  status: "COMPLETED",
  triggerType: "MANUAL",
  scopeType: "MEASURE",
  startedAt: "2026-08-30T00:00:00Z",
  completedAt: "2026-08-30T00:01:00Z",
  totalEvaluated: 1,
  totalCases: 1,
  compliantCount: 0,
  nonCompliantCount: 1,
  passRate: 0,
  durationMs: 60_000,
  outcomeCounts: [{ status: "OVERDUE", count: 1 }],
  dataFreshAsOf: "2026-08-30T00:01:00Z",
  dataFreshnessMinutes: 1,
};

const outcome = {
  employeeName: "Ada Lovelace",
  employeeExternalId: "emp-041",
  role: "Nurse",
  site: "HQ",
  outcomeStatus: "OVERDUE",
  daysSinceExam: "12",
  waiverStatus: "NONE",
  caseId: "case-1",
};

beforeEach(() => {
  setSubject("employee");
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/runs?limit=20") return Promise.resolve([run]);
    if (url === "/api/measures") return Promise.resolve([]);
    if (url === "/api/runs/run-1") return Promise.resolve(summary);
    if (url === "/api/runs/run-1/logs?limit=200") return Promise.resolve([]);
    if (url === "/api/runs/run-1/outcomes") return Promise.resolve([outcome]);
    return Promise.resolve([]);
  });
});

describe("RunsPage terminology", () => {
  it("removes the role column and uses patient outcome labels and id hint", async () => {
    setSubject("patient");
    render(<RunsPage />);
    const grid = await screen.findByTestId("outcomes-grid");

    expect(within(grid).queryByText("Role")).not.toBeInTheDocument();
    expect(within(grid).getByText("Exclusion")).toBeInTheDocument();
    expect(within(grid).getByText("Days Since Result")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "Scope" }));
    await userEvent.click(screen.getByRole("option", { name: "Employee" }));
    expect(screen.getByPlaceholderText("Enter a patient external ID, for example pat-048")).toBeInTheDocument();
  });

  it("keeps the employee outcome columns and id hint", async () => {
    render(<RunsPage />);
    const grid = await screen.findByTestId("outcomes-grid");

    expect(within(grid).getByText("Role")).toBeInTheDocument();
    expect(within(grid).getByText("Waiver")).toBeInTheDocument();
    expect(within(grid).getByText("Days Since Exam")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "Scope" }));
    await userEvent.click(screen.getByRole("option", { name: "Employee" }));
    expect(screen.getByPlaceholderText("Enter an employee external ID, for example emp-041")).toBeInTheDocument();
  });
});
