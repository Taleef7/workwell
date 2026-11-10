/**
 * Cases for the staff seat (#880, LOCKED §4A.9): it lands on "mine", works one case at a time, and
 * gets none of the lead's practice-wide levers (bulk actions, attributed lists).
 */
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
const apiMock = { getWithHeaders, get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/cases");
  return navHolder.current.navigation;
});
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
const auth = vi.hoisted(() => ({ role: "ROLE_QUALITY_STAFF" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: auth.role, email: "quality-staff@maui.workwell.dev" } }),
}));

import CasesPage from "../page";

const ONE_CASE = {
  caseId: "case-1",
  employeeId: "maui-pat-00001",
  employeeName: "Lisa Carter",
  site: "Wailuku",
  measureId: "cms125",
  measureVersionId: "cms125",
  measureName: "Breast Cancer Screening",
  measureVersion: "v14",
  evaluationPeriod: "2027-01-01",
  status: "OPEN",
  priority: "MEDIUM",
  assignee: "quality-staff@maui.workwell.dev",
  currentOutcomeStatus: "OVERDUE",
  lastRunId: "run-1",
  exclusionReason: null,
  waiverExpiresAt: null,
  waiverExpired: false,
  updatedAt: "2026-09-11T00:00:00Z",
};

const caseCalls = () => getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/cases?"));
const respond = (rows: unknown[]) =>
  getWithHeaders.mockReset().mockResolvedValue({ data: rows, headers: new Headers({ "X-Total-Count": String(rows.length) }) });

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_QUALITY_STAFF";
  navHolder.current.setUrl("/cases?view=mine");
  get.mockReset().mockResolvedValue([]);
  post.mockReset().mockResolvedValue(undefined);
  respond([ONE_CASE]);
});

describe("Cases for the staff seat (#880)", () => {
  it("names its own list, drops the Assignee filter, and offers no bulk selection", async () => {
    render(<CasesPage />);
    expect(await screen.findByRole("heading", { name: "Assigned to you" })).toBeInTheDocument();
    expect(screen.getByText("Gaps assigned to you, from any panel. Open one to work it.")).toBeInTheDocument();
    await waitFor(() => expect(caseCalls().at(-1)).toContain("assignee=quality-staff%40maui.workwell.dev"));
    await screen.findByText("Lisa Carter");
    expect(screen.queryByRole("combobox", { name: "Assignee" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Attributed list" })).toBeNull();
    // The way into the gap reads as what it is.
    expect(screen.getByRole("link", { name: "Open case →" })).toHaveAttribute("href", "/cases/case-1");
    // Lists are never fetched for a seat that cannot use them.
    expect(get.mock.calls.map((c) => String(c[0]))).not.toContain("/api/subject-lists");
  });

  it("says when nothing is assigned, and offers the whole practice", async () => {
    respond([]);
    render(<CasesPage />);
    const empty = await screen.findByText(/Nothing is assigned to you\./);
    expect(within(empty).getByRole("link", { name: "See all cases →" }).getAttribute("href")).toContain("view=all");
  });

  it("the all-cases empty state does not tell a seat that cannot run measures to run one", async () => {
    // Outside January to March, whose empty state adds the new year's sentence (page.january.test.tsx).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 15, 10));
    try {
      navHolder.current.setUrl("/cases?view=all");
      respond([]);
      render(<CasesPage />);
      expect(await screen.findByText("No open cases for the current filters.")).toBeInTheDocument();
      expect(screen.queryByText(/Run a measure/)).toBeNull();
      // The Assignee filter is back on All cases.
      expect(screen.getByRole("combobox", { name: "Assignee" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the lead keeps bulk selection on the same list", async () => {
    auth.role = "ROLE_CASE_MANAGER";
    navHolder.current.setUrl("/cases");
    render(<CasesPage />);
    expect(await screen.findByRole("checkbox", { name: /select lisa carter/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open and recent cases" })).toBeInTheDocument();
  });
});
