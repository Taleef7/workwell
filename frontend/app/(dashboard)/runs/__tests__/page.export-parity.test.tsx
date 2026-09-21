/**
 * The runs CSV must describe the history it was taken from (#601).
 *
 * "Export runs CSV" sent no filters at all and `/api/exports/runs` accepted none, so filtering the
 * history to FAILED runs at one site last week and pressing Export downloaded the most recent 200
 * runs of everything. No error, and the file looked plausible.
 *
 * The assertion is deliberately not a list of parameter names: it compares the export's query string
 * with the list request's, so a filter added to one and not the other fails without this test being
 * edited. Same guard as the cases page carries.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const downloadBlob = vi.fn();
const apiMock = { get, post: vi.fn(), downloadBlob };
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
const globals = vi.hoisted(() => ({ current: { siteId: "", from: "", to: "" } }));

vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock, useSearchParams: () => searchParamsMock }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => globals.current }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({ default: () => <div data-testid="outcomes-grid" /> }));

import RunsPage from "../page";

const listCalls = () => get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/runs?"));
const exportCalls = () => downloadBlob.mock.calls.map((c) => String(c[0]));
const paramsOf = (url: string) => new URLSearchParams(url.slice(url.indexOf("?") + 1));

beforeEach(() => {
  globals.current = { siteId: "", from: "", to: "" };
  downloadBlob.mockReset().mockResolvedValue(new Blob(["runId\n"]));
  get.mockReset().mockResolvedValue([]);
  Object.defineProperty(window.URL, "createObjectURL", { value: vi.fn(() => "blob:x"), writable: true });
  Object.defineProperty(window.URL, "revokeObjectURL", { value: vi.fn(), writable: true });
});

describe("runs export carries the filters the history is showing", () => {
  it("sends every list filter, minus paging", async () => {
    // site / from / to come from the global filter bar rather than the URL, so they are exactly the
    // ones an export URL spelled by hand had no way to carry.
    globals.current = { siteId: "plant-a", from: "2026-01-01", to: "2026-06-30" };
    render(<RunsPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: /export runs csv/i }));
    await waitFor(() => expect(exportCalls().length).toBe(1));

    const listed = paramsOf(listCalls().at(-1)!);
    const exported = paramsOf(exportCalls()[0]!);
    expect(exported.get("format")).toBe("csv");

    const listedFilters = [...listed.entries()].filter(([k]) => k !== "limit").sort();
    const exportedFilters = [...exported.entries()].filter(([k]) => k !== "format").sort();
    expect(exportedFilters).toEqual(listedFilters);

    // Not vacuous: the three the old URL dropped are actually present.
    for (const key of ["site", "from", "to"]) expect(exported.has(key)).toBe(true);
  });

  it("the outcomes export on the same screen carries the site filter too", async () => {
    globals.current = { siteId: "plant-a", from: "", to: "" };
    render(<RunsPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: /export outcomes csv/i }));
    await waitFor(() => expect(exportCalls().length).toBe(1));
    expect(exportCalls()[0]).toContain("site=plant-a");
  });
});
