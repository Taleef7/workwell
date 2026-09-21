/**
 * The CSV must describe the list it was taken from (B-10).
 *
 * The export button used to spell its own URL with three of the nine filters the list sends, so a
 * CSV taken from a work list narrowed by site, a date window, an outcome or a search was a WIDER
 * file than the screen — under a heading that said otherwise, with nothing to notice. The assertion
 * here is deliberately not a list of parameter names: it compares the export's query string with the
 * list request's, so a filter added to one and not the other fails without this test being edited.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";

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

// The site + date window come from the global filter bar, not the URL — so they are exactly the
// filters the old export URL had no way to carry.
const globals = vi.hoisted(() => ({ current: { siteId: "", from: "", to: "" } }));
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => globals.current,
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN", email: "admin@example.com" } }),
}));

import CasesPage from "../page";

const listCalls = () => getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/cases?"));
const exportCalls = () => downloadBlob.mock.calls.map((c) => String(c[0]));
const paramsOf = (url: string) => new URLSearchParams(url.slice(url.indexOf("?") + 1));

beforeEach(() => {
  navHolder.current.setUrl("/cases");
  globals.current = { siteId: "", from: "", to: "" };
  get.mockReset().mockResolvedValue([]);
  downloadBlob.mockReset().mockResolvedValue(new Blob(["caseId\n"]));
  getWithHeaders.mockReset().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
  // jsdom has no object-URL plumbing; the export helper builds and revokes one.
  Object.defineProperty(window.URL, "createObjectURL", { value: vi.fn(() => "blob:x"), writable: true });
  Object.defineProperty(window.URL, "revokeObjectURL", { value: vi.fn(), writable: true });
});

describe("cases export carries the filters the list is showing", () => {
  it("sends every list filter, minus paging", async () => {
    globals.current = { siteId: "plant-a", from: "2026-01-01", to: "2026-06-30" };
    navHolder.current.setUrl(
      "/cases?status=open&measureId=cms125&outcome=OVERDUE&providerId=maui-prov-012&search=omar",
    );
    render(<CasesPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: /export cases csv/i }));
    await waitFor(() => expect(exportCalls().length).toBe(1));

    const listed = paramsOf(listCalls().at(-1)!);
    const exported = paramsOf(exportCalls()[0]!);
    expect(exported.get("format")).toBe("csv");

    // Paging is the list's own concern; an export is not paged.
    const listedFilters = [...listed.entries()].filter(([k]) => k !== "limit" && k !== "offset").sort();
    const exportedFilters = [...exported.entries()].filter(([k]) => k !== "format").sort();
    expect(exportedFilters).toEqual(listedFilters);

    // Not vacuous: the six that used to be dropped are actually present.
    for (const key of ["priority", "assignee"]) expect(exported.has(key)).toBe(false); // unset in this test
    for (const key of ["site", "from", "to", "outcome", "search", "status", "measureId", "providerId"]) {
      expect(exported.has(key)).toBe(true);
    }
    // And the period SCOPE, which used to be a server-side default present in neither string and was
    // therefore the one width difference this comparison could not see (#603). `/api/cases` defaults
    // the open list to the current cycle; `/api/exports/cases` defaults to all history, documented.
    expect(exported.get("period")).toBe("current");
  });

  it("sends the period scope only on the tabs that HAVE one (#603)", async () => {
    // On a non-cycle tab `period` would reach the store as a LITERAL evaluation period and match
    // nothing, so this is the rule's own condition rather than a tidy-up.
    for (const [status, expected] of [["open", "current"], ["staff_closed", "current"], ["closed", null], ["all", null]] as const) {
      get.mockClear();
      getWithHeaders.mockClear();
      downloadBlob.mockClear();
      navHolder.current.setUrl(`/cases?status=${status}`);
      const view = render(<CasesPage />);
      await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
      expect(paramsOf(listCalls().at(-1)!).get("period")).toBe(expected);

      await userEvent.click(screen.getByRole("button", { name: /export cases csv/i }));
      await waitFor(() => expect(exportCalls().length).toBe(1));
      expect(paramsOf(exportCalls()[0]!).get("period")).toBe(expected);
      view.unmount();
    }
  });

  it("follows the list when a filter changes, rather than exporting the first one it saw", async () => {
    navHolder.current.setUrl("/cases?measureId=cms125");
    render(<CasesPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    navHolder.current.setUrl("/cases?measureId=cms122&outcome=DUE_SOON");
    await waitFor(() => expect(listCalls().at(-1)).toContain("measureId=cms122"));

    await userEvent.click(screen.getByRole("button", { name: /export cases csv/i }));
    await waitFor(() => expect(exportCalls().length).toBe(1));
    expect(exportCalls()[0]).toContain("measureId=cms122");
    expect(exportCalls()[0]).toContain("outcome=DUE_SOON");
    expect(exportCalls()[0]).not.toContain("cms125");
  });
});
