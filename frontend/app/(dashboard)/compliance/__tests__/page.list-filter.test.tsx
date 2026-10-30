/**
 * The roster's "Attributed list" filter (#874).
 *
 * The roster is the one place every list member shows, compliant ones included, so a list chosen here
 * has to reach the roster query, the "Filtered to" row, the page and selection resets, and the link to
 * the work list. A seat the server would refuse never sends it.
 */
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  navHolder.current = createNavMock("/compliance");
  return navHolder.current.navigation;
});

const auth = vi.hoisted(() => ({ role: "ROLE_CASE_MANAGER" }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));

import CompliancePage from "../page";

const LIST = {
  id: "list-q3",
  name: "ACO Q3 attribution",
  revision: 1,
  source: null,
  note: null,
  createdBy: "admin@maui.workwell.dev",
  createdAt: "2026-09-24T00:00:00.000Z",
  counts: { MATCHED: 250, NOT_FOUND: 1, AMBIGUOUS: 0 },
};
const ASSIGNABLE = [{ email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" }];
const roster = (total: number) => ({
  data: {
    panel: "wellness",
    columns: [{ measureId: "cms125", name: "Breast Cancer Screening", complianceClass: "RECURRING" }],
    rows: [
      {
        subject: { externalId: "pat-1", name: "Overdue Patient", role: "Patient", site: "HQ", tenantName: "Acme" },
        cells: { cms125: { status: "OVERDUE", method: "No mammogram on file" } },
      },
    ],
  },
  headers: new Headers({ "X-Total-Count": String(total) }),
});

const rosterCalls = () =>
  getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/compliance/roster?"));
const listFetches = () => get.mock.calls.map((c) => String(c[0])).filter((u) => u === "/api/subject-lists");

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_CASE_MANAGER";
  navHolder.current.setUrl("/compliance?panel=wellness");
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/subject-lists") return Promise.resolve([LIST]);
    if (url === "/api/users/assignable") return Promise.resolve(ASSIGNABLE);
    return Promise.resolve([]);
  });
  getWithHeaders.mockReset().mockResolvedValue(roster(1));
});
afterEach(() => vi.clearAllMocks());

it("a list in the URL reaches the roster query, the Filtered-to row and the work-list link", async () => {
  navHolder.current.setUrl("/compliance?panel=wellness&listId=list-q3");
  render(<CompliancePage />);
  await waitFor(() => expect(rosterCalls().at(-1)).toContain("listId=list-q3"));
  expect(await screen.findByText("Attributed list: ACO Q3 attribution")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Work the open gaps on the work list/ }).getAttribute("href")).toContain(
    "listId=list-q3",
  );
  // The one unmatched member is said, so a list of 251 showing 250 is not a mystery.
  expect(screen.getByText(/1 list member isn't matched to a patient here/)).toBeInTheDocument();

  // The row's Clear clears the list with the other narrowings.
  const filteredTo = screen.getByText("Filtered to").parentElement!;
  await userEvent.click(within(filteredTo).getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(navHolder.current.params.has("listId")).toBe(false));
  await waitFor(() => expect(rosterCalls().at(-1)).not.toContain("listId"));
});

it("choosing a list writes the URL and returns to page 1", async () => {
  getWithHeaders.mockResolvedValue(roster(120));
  render(<CompliancePage />);
  // Enabled once the total has loaded: a click on the disabled button would page nowhere.
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rosterCalls().at(-1)).toContain("page=2"));

  await waitFor(() => expect(screen.getByRole("option", { name: /^ACO Q3 attribution · / })).toBeInTheDocument());
  await userEvent.selectOptions(screen.getByLabelText("Attributed list"), "list-q3");
  expect(navHolder.current.params.get("listId")).toBe("list-q3");
  await waitFor(() => {
    const latest = rosterCalls().at(-1)!;
    expect(latest).toContain("listId=list-q3");
    expect(latest).toContain("page=1");
  });
});

it("a selection does not survive a change of list", async () => {
  navHolder.current.setUrl("/compliance?panel=wellness&measureId=cms125");
  render(<CompliancePage />);
  await userEvent.click(await screen.findByLabelText("Select Overdue Patient"));
  expect(screen.getByText("1 selected")).toBeInTheDocument();
  // The same rows come back, so only the scope key can empty the selection.
  navHolder.current.setUrl("/compliance?panel=wellness&measureId=cms125&listId=list-q3");
  await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
});

it("a VIEWER never fetches the lists, never sends a list, and is told the link's list was not applied", async () => {
  auth.role = "ROLE_VIEWER";
  navHolder.current.setUrl("/compliance?panel=wellness&listId=list-q3");
  render(<CompliancePage />);
  await waitFor(() => expect(rosterCalls().length).toBeGreaterThan(0));
  expect(await screen.findByTestId("list-filter-note")).toHaveTextContent(/Attributed lists are for case managers/);
  for (const call of rosterCalls()) expect(call).not.toContain("listId");
  expect(listFetches()).toEqual([]);
  expect(screen.queryByLabelText("Attributed list")).toBeNull();

  // With no picker or chip, the note's button is the only way to take the id out of the URL.
  await userEvent.click(screen.getByRole("button", { name: "Remove it from the link" }));
  await waitFor(() => expect(navHolder.current.params.has("listId")).toBe(false));
  expect(screen.queryByTestId("list-filter-note")).toBeNull();
});
