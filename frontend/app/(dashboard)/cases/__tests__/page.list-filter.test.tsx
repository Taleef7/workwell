/**
 * Cases' "Attributed list" filter (#874). The list, "load more" and the CSV share `caseFilterParams`
 * (the CSV half is pinned in `page.export-parity.test.tsx`); this pins the picker, the link to the work
 * list, and a VIEWER's link.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const getWithHeaders = vi.fn();
const get = vi.fn();
const downloadBlob = vi.fn();
const apiMock = { getWithHeaders, get, downloadBlob };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/cases");
  return navHolder.current.navigation;
});
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
const auth = vi.hoisted(() => ({ role: "ROLE_CASE_MANAGER" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: auth.role, email: "quality-lead@maui.workwell.dev" } }),
}));

import CasesPage from "../page";

const LIST = {
  id: "list-q3",
  name: "ACO Q3 attribution",
  revision: 1,
  source: null,
  note: null,
  createdBy: "admin@maui.workwell.dev",
  createdAt: "2026-09-24T00:00:00.000Z",
  counts: { MATCHED: 250, NOT_FOUND: 0, AMBIGUOUS: 0 },
};

const listCalls = () => getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/cases?"));
const listFetches = () => get.mock.calls.map((c) => String(c[0])).filter((u) => u === "/api/subject-lists");

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_CASE_MANAGER";
  navHolder.current.setUrl("/cases");
  get.mockReset().mockImplementation((url: string) => Promise.resolve(url === "/api/subject-lists" ? [LIST] : []));
  getWithHeaders.mockReset().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
});

it("choosing a list narrows the cases, and the link to the work list keeps it", async () => {
  render(<CasesPage />);
  await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
  await userEvent.click(screen.getByRole("combobox", { name: "Attributed list" }));
  await userEvent.click(await screen.findByRole("option", { name: /^ACO Q3 attribution · / }));
  await waitFor(() => expect(navHolder.current.params.get("listId")).toBe("list-q3"));
  await waitFor(() => expect(listCalls().at(-1)).toContain("listId=list-q3"));
  expect(screen.getByRole("link", { name: /on the work list/ }).getAttribute("href")).toContain("listId=list-q3");
});

it("a VIEWER never fetches the lists, never sends a list, and is told the link's list was not applied", async () => {
  auth.role = "ROLE_VIEWER";
  navHolder.current.setUrl("/cases?listId=list-q3");
  render(<CasesPage />);
  await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
  expect(await screen.findByTestId("list-filter-note")).toHaveTextContent(/Attributed lists are for case managers/);
  for (const call of listCalls()) expect(call).not.toContain("listId");
  expect(listFetches()).toEqual([]);
  expect(screen.queryByRole("combobox", { name: "Attributed list" })).toBeNull();
});
