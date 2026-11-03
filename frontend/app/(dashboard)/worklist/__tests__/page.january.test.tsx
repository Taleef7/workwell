/**
 * The work list's empty open list from January to March (#882): last year's gaps closed when the year
 * began, and this year's open only as patients are seen. The rest of the year, and the staff-closed view,
 * say what they always said. The clock is faked for `Date` only, at local dates.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  navHolder.current = createNavMock("/worklist");
  return navHolder.current.navigation;
});
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "quality-lead@maui.workwell.dev" } }),
}));

import WorklistPage from "../page";

const OPEN_EMPTY = "No patients with open gaps match these filters.";
const NEW_YEAR = "2026's gaps closed when 2027 began. 2027's gaps appear as patients are seen, so this list starts short in January.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2027, 1, 3, 9));
  setSubject("patient");
  navHolder.current.setUrl("/worklist?panel=all");
  get.mockReset().mockResolvedValue([]);
  post.mockReset().mockResolvedValue(undefined);
  getWithHeaders.mockReset().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the work list's empty open list (#882)", () => {
  it("says last year's gaps closed, January to March", async () => {
    render(<WorklistPage />);
    expect(await screen.findByText(`${OPEN_EMPTY} ${NEW_YEAR}`)).toBeInTheDocument();
  });

  it("is exactly as before from April", async () => {
    vi.setSystemTime(new Date(2027, 3, 1, 9));
    render(<WorklistPage />);
    expect(await screen.findByText(OPEN_EMPTY)).toBeInTheDocument();
    expect(screen.queryByText(/gaps closed when/)).toBeNull();
  });

  it("leaves the staff-closed view alone: it is not this year's open work", async () => {
    navHolder.current.setUrl("/worklist?panel=all&status=staff_closed");
    render(<WorklistPage />);
    expect(await screen.findByText("No patients with gaps closed by staff match these filters.")).toBeInTheDocument();
    expect(screen.queryByText(/gaps closed when/)).toBeNull();
  });
});
