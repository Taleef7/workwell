/**
 * "Select all N matching" on the patient work list: the step from a ticked page to every patient the
 * filters match, before a bulk assign. A provider's open gaps are often more than one page.
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
const apiMock = { getWithHeaders, get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/worklist");
  return navHolder.current.navigation;
});

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "2026-01-01", to: "2026-12-31" }),
}));
const emitToast = vi.fn();
vi.mock("@/lib/toast", () => ({ emitToast: (...args: unknown[]) => emitToast(...args) }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "quality-lead@maui.workwell.dev" } }),
}));

import WorklistPage from "../page";

type Row = ReturnType<typeof patient>;
type ListResponse = { data: Row[]; headers: Headers };

function patient(i: number, gaps = 2, assignee: string | null = null) {
  return {
    employeeId: `maui-pat-${i}`,
    employeeName: `Patient ${i}`,
    site: "Wailuku",
    providerId: "maui-prov-012",
    providerName: "NP Kira Venn",
    payer: "1",
    payerName: "Medicare",
    gapCount: gaps,
    highestPriority: "HIGH",
    owner: assignee,
    assignees: assignee ? [assignee] : [],
    updatedAt: "2026-09-11T00:00:00Z",
    openGaps: Array.from({ length: gaps }, (_, g) => ({
      caseId: `case-${i}-${g}`,
      measureId: "cms125",
      measureName: "Breast Cancer Screening",
      status: "OPEN",
      outcomeStatus: "OVERDUE",
      priority: "HIGH",
      assignee,
      nextAction: null,
      evaluationPeriod: "2027-01-01",
      updatedAt: "2026-09-11T00:00:00Z",
    })),
  };
}
const patients = (from: number, to: number, gaps = 2) =>
  Array.from({ length: to - from + 1 }, (_, k) => patient(from + k, gaps));
const respond = (data: Row[], total: number): ListResponse => ({ data, headers: new Headers({ "X-Total-Count": String(total) }) });

const ASSIGNABLE = [
  { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
];

/** The page the list loads, and what the select-all GET answers (`limit=500`). */
let pageResponse: ListResponse;
let matchingResponse: () => Promise<ListResponse>;

const listCalls = (): string[] =>
  getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/worklist/patients"));
const selectAllCalls = () => listCalls().filter((u) => u.includes("limit=500"));

/** The header checkbox, once the rows it would tick have loaded (it renders over an empty list too). */
async function pageCheckbox() {
  await screen.findByRole("checkbox", { name: "Select Patient 1" });
  return screen.getByRole("checkbox", { name: /^Select all (patients|employees) on this page$/ });
}
const offer = () => screen.queryByRole("button", { name: /^Select all \d[\d,]* matching (patients|employees)$/ });
const matchingClaim = () => screen.queryByText(/^All \d[\d,]* matching (patients|employees?) selected/);

async function chooseAssignee() {
  await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
  await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));
}

/** Ticks the whole page and takes the offer, waiting for the bar to claim the matching set. */
async function selectAllMatching(expected: RegExp) {
  await userEvent.click(await pageCheckbox());
  await userEvent.click(await screen.findByRole("button", { name: /^Select all \d[\d,]* matching/ }));
  expect(await screen.findByText(expected)).toBeInTheDocument();
}

function deferred() {
  let resolve!: (value: ListResponse) => void;
  const promise = new Promise<ListResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  navHolder.current.setUrl("/worklist");
  post.mockReset().mockResolvedValue({ assigned: 10, unchanged: 0, conflicted: 0, missing: [], closed: [] });
  emitToast.mockReset();
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/users/assignable")) return Promise.resolve(ASSIGNABLE);
    return Promise.resolve([]);
  });
  // A page of three, out of five that match.
  pageResponse = respond(patients(1, 3), 5);
  matchingResponse = () => Promise.resolve(respond(patients(1, 5), 5));
  getWithHeaders.mockReset().mockImplementation((url: string) =>
    url.includes("limit=500") ? matchingResponse() : Promise.resolve(pageResponse),
  );
});

describe("WorklistPage — select all N matching", () => {
  it("is offered only once the whole page is ticked and the list runs past it", async () => {
    render(<WorklistPage />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Patient 1" }));
    expect(await screen.findByText(/^1 (patient|employee) selected$/)).toBeInTheDocument();
    expect(offer()).toBeNull();

    await userEvent.click(await pageCheckbox());
    expect(await screen.findByRole("button", { name: /^Select all 5 matching (patients|employees)$/ })).toBeEnabled();
  });

  it("is not offered when the page already holds every match", async () => {
    pageResponse = respond(patients(1, 3), 3);
    render(<WorklistPage />);
    await userEvent.click(await pageCheckbox());
    expect(await screen.findByText(/^3 (patients|employees) selected$/)).toBeInTheDocument();
    expect(offer()).toBeNull();
  });

  it("asks for the first 500 under exactly the page's filters, and the bar then counts every match", async () => {
    navHolder.current.setUrl(
      "/worklist?panel=me&listId=list-q3&providerId=maui-prov-012&measureId=cms125&outcome=OVERDUE&assignee=unassigned&search=Patient&payer=1&payer=11",
    );
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const pageUrl = listCalls().at(-1)!;
    // The page load's own query, so the comparison below is not against a URL nobody filtered.
    expect(pageUrl).toContain("limit=25&offset=0");
    for (const part of ["panel=me", "listId=list-q3", "providerId=maui-prov-012", "measureId=cms125", "outcome=OVERDUE", "assignee=unassigned", "search=Patient", "payer=1&payer=11", "from=2026-01-01", "to=2026-12-31"]) {
      expect(pageUrl).toContain(part);
    }

    await selectAllMatching(/^All 5 matching (patients|employees) selected \(10 open gaps\)$/);
    expect(selectAllCalls()).toEqual([pageUrl.replace("limit=25&offset=0", "limit=500&offset=0")]);
    expect(screen.getByRole("button", { name: "Assign 10 open gaps" })).toBeInTheDocument();
    expect(offer()).toBeNull();
  });

  it("assigns every matching patient's gaps, including patients that were never on the page", async () => {
    render(<WorklistPage />);
    await selectAllMatching(/^All 5 matching/);
    await chooseAssignee();
    await userEvent.click(screen.getByRole("button", { name: "Assign 10 open gaps" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/cases/bulk-assign", {
      assignee: "quality-staff@maui.workwell.dev",
      caseIds: patients(1, 5).flatMap((p) => p.openGaps.map((g) => g.caseId)),
    });
    // Done: the selection clears and the list reloads, as after a page-only assign.
    await waitFor(() => expect(matchingClaim()).toBeNull());
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("counts the matching patients' gaps against the one-request cap, and refuses over it", async () => {
    // 120 patients is under the 500-patient select limit; their 600 gaps are over the 500-gap assign cap.
    pageResponse = respond(patients(1, 3, 5), 120);
    matchingResponse = () => Promise.resolve(respond(patients(1, 120, 5), 120));
    render(<WorklistPage />);
    await selectAllMatching(/^All 120 matching (patients|employees) selected \(600 open gaps\)$/);
    await chooseAssignee();

    expect(screen.getByText(/too many for one assignment \(600 gaps, limit 500\) — narrow the filters/i)).toBeInTheDocument();
    const assign = screen.getByRole("button", { name: "Assign 600 open gaps" });
    expect(assign).toBeDisabled();
    await userEvent.click(assign);
    expect(post).not.toHaveBeenCalled();
  });

  it("warns about the matching patients' gaps that belong to someone else, not just the page's", async () => {
    // Every page patient is unassigned; two of the matches off the page are a colleague's.
    matchingResponse = () =>
      Promise.resolve(respond([...patients(1, 3), patient(4, 2, "someone.else@maui.workwell.dev"), patient(5)], 5));
    render(<WorklistPage />);
    await selectAllMatching(/^All 5 matching/);
    await chooseAssignee();
    expect(await screen.findByText("2 of 10 currently belong to someone else.")).toBeInTheDocument();
  });

  it("refuses more than 500 matches, saying to narrow the filters", async () => {
    pageResponse = respond(patients(1, 3), 501);
    render(<WorklistPage />);
    await userEvent.click(await pageCheckbox());
    const button = await screen.findByRole("button", { name: /^Select all 501 matching (patients|employees)$/ });
    expect(button).toBeDisabled();
    const reason = screen.getByText(/^More than 500 (patients|employees) match\. Narrow the filters/);
    expect(button).toHaveAttribute("aria-describedby", reason.id);
    await userEvent.click(button);
    expect(selectAllCalls()).toEqual([]);
  });

  it("unticking a row goes back to the boxes on screen", async () => {
    render(<WorklistPage />);
    await selectAllMatching(/^All 5 matching/);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Patient 2" }));

    expect(matchingClaim()).toBeNull();
    expect(screen.getByText(/^2 (patients|employees) selected$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign 4 open gaps" })).toBeInTheDocument();
  });

  it("Clear selection clears the matching set, and ticking the page again offers it afresh", async () => {
    render(<WorklistPage />);
    await selectAllMatching(/^All 5 matching/);
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(matchingClaim()).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();

    await userEvent.click(await pageCheckbox());
    expect(await screen.findByText(/^3 (patients|employees) selected$/)).toBeInTheDocument();
    expect(offer()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Assign 6 open gaps" })).toBeInTheDocument();
  });

  it("a failed fetch says so and keeps the page selected", async () => {
    matchingResponse = () => Promise.reject(new Error("Gateway Timeout"));
    render(<WorklistPage />);
    await userEvent.click(await pageCheckbox());
    await userEvent.click(await screen.findByRole("button", { name: /^Select all 5 matching/ }));

    await waitFor(() => expect(emitToast).toHaveBeenCalledWith(expect.stringContaining("Gateway Timeout"), "error"));
    expect(matchingClaim()).toBeNull();
    expect(screen.getByText(/^3 (patients|employees) selected$/)).toBeInTheDocument();
    // Offered again, not stuck on its loading label.
    expect(await screen.findByRole("button", { name: /^Select all 5 matching/ })).toBeEnabled();
  });

  it("does not call a truncated answer 'all': a list that grew past 500 since the page loaded is refused", async () => {
    pageResponse = respond(patients(1, 3, 1), 480);
    matchingResponse = () => Promise.resolve(respond(patients(1, 500, 1), 520));
    render(<WorklistPage />);
    await userEvent.click(await pageCheckbox());
    await userEvent.click(await screen.findByRole("button", { name: /^Select all 480 matching/ }));

    await waitFor(() => expect(emitToast).toHaveBeenCalledWith(expect.stringMatching(/^520 (patients|employees) now match/), "error"));
    expect(matchingClaim()).toBeNull();
    expect(screen.getByRole("button", { name: "Assign 3 open gaps" })).toBeInTheDocument();
  });
});

describe("WorklistPage — select all N matching never applies a stale answer", () => {
  it("drops the answer when the list reloads while it is in flight", async () => {
    const held = deferred();
    matchingResponse = () => held.promise;
    render(<WorklistPage />);
    await userEvent.click(await pageCheckbox());
    await userEvent.click(await screen.findByRole("button", { name: /^Select all 5 matching/ }));
    expect(await screen.findByRole("button", { name: /^Selecting all 5 (patients|employees)…$/ })).toBeDisabled();

    // A reload with nothing to do with the router: the page size changes, `load` runs again.
    await userEvent.click(screen.getByRole("combobox", { name: /per page/i }));
    await userEvent.click(await screen.findByRole("option", { name: "50" }));
    await waitFor(() => expect(listCalls().some((u) => u.includes("limit=50&"))).toBe(true));
    // The reload kept the three ticked rows (they are still on the list), so the bar is back to them.
    expect(await screen.findByText(/^3 (patients|employees) selected$/)).toBeInTheDocument();

    await act(async () => {
      held.resolve(respond(patients(1, 5), 5));
      await held.promise;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(matchingClaim()).toBeNull();
    expect(screen.getByRole("button", { name: "Assign 6 open gaps" })).toBeInTheDocument();
  });

  it("a reload ends a matching set that had already answered", async () => {
    render(<WorklistPage />);
    await selectAllMatching(/^All 5 matching/);
    await userEvent.click(screen.getByRole("combobox", { name: /per page/i }));
    await userEvent.click(await screen.findByRole("option", { name: "50" }));
    await waitFor(() => expect(listCalls().some((u) => u.includes("limit=50&"))).toBe(true));
    await waitFor(() => expect(matchingClaim()).toBeNull());
    expect(await screen.findByText(/^3 (patients|employees) selected$/)).toBeInTheDocument();
  });

  it("is not offered while the list reloads: the rows on screen are the outgoing list's", async () => {
    render(<WorklistPage />);
    await userEvent.click(await pageCheckbox());
    expect(await screen.findByRole("button", { name: /^Select all 5 matching/ })).toBeInTheDocument();

    // The next page load never answers, so the list stays loading with the old rows ticked.
    getWithHeaders.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(screen.getByRole("combobox", { name: /per page/i }));
    await userEvent.click(await screen.findByRole("option", { name: "50" }));
    await waitFor(() => expect(listCalls().some((u) => u.includes("limit=50&"))).toBe(true));
    await waitFor(() => expect(offer()).toBeNull());
  });

  it("drops the answer when a box is unticked while it is in flight", async () => {
    const held = deferred();
    matchingResponse = () => held.promise;
    render(<WorklistPage />);
    await userEvent.click(await pageCheckbox());
    await userEvent.click(await screen.findByRole("button", { name: /^Select all 5 matching/ }));
    await screen.findByRole("button", { name: /^Selecting all 5/ });

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Patient 1" }));
    await act(async () => {
      held.resolve(respond(patients(1, 5), 5));
      await held.promise;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(matchingClaim()).toBeNull();
    expect(screen.getByText(/^2 (patients|employees) selected$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign 4 open gaps" })).toBeInTheDocument();
  });
});
