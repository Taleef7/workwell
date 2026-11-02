/**
 * An empty open-cases list from January to March (#882). The year's first nightly closed every open case
 * of the year before, and this year's open only as patients are seen, so an empty list then is the new
 * year's and "run a measure" is not the answer. The rest of the year the empty states are as they were.
 * The clock is faked for `Date` only, at local dates.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
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
  navHolder.current = createNavMock("/cases");
  return navHolder.current.navigation;
});
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
const auth = vi.hoisted(() => ({ role: "ROLE_CASE_MANAGER" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: auth.role, email: "quality-staff@maui.workwell.dev" } }),
}));

import CasesPage from "../page";

const NEW_YEAR = "2026's gaps closed when 2027 began. 2027's gaps appear as patients are seen, so this list starts short in January.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2027, 0, 6, 9));
  setSubject("patient");
  auth.role = "ROLE_CASE_MANAGER";
  get.mockReset().mockResolvedValue([]);
  post.mockReset().mockResolvedValue(undefined);
  getWithHeaders.mockReset().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Cases' empty open list, January to March (#882)", () => {
  it("tells the lead last year's gaps closed, not to run a measure", async () => {
    navHolder.current.setUrl("/cases?view=all");
    render(<CasesPage />);
    expect(await screen.findByText(`No open cases. ${NEW_YEAR}`)).toBeInTheDocument();
    expect(screen.queryByText(/Run a measure/)).toBeNull();
  });

  it("tells the staff seat why nothing is assigned yet, and still offers every case", async () => {
    auth.role = "ROLE_QUALITY_STAFF";
    navHolder.current.setUrl("/cases?view=mine");
    render(<CasesPage />);
    const empty = await screen.findByText(/Nothing is assigned to you\./);
    expect(empty).toHaveTextContent(`Nothing is assigned to you. ${NEW_YEAR} See all cases →`);
    expect(within(empty).getByRole("link", { name: "See all cases →" })).toBeInTheDocument();
  });

  it("says it on the staff seat's all-cases list too", async () => {
    auth.role = "ROLE_QUALITY_STAFF";
    navHolder.current.setUrl("/cases?view=all");
    render(<CasesPage />);
    expect(await screen.findByText(`No open cases for the current filters. ${NEW_YEAR}`)).toBeInTheDocument();
  });

  it("is exactly as before from April", async () => {
    vi.setSystemTime(new Date(2027, 3, 1, 9));
    navHolder.current.setUrl("/cases?view=all");
    const { unmount } = render(<CasesPage />);
    expect(await screen.findByText("No open cases. Run a measure to generate cases.")).toBeInTheDocument();
    expect(screen.queryByText(/gaps closed when/)).toBeNull();
    unmount();

    auth.role = "ROLE_QUALITY_STAFF";
    navHolder.current.setUrl("/cases?view=mine");
    render(<CasesPage />);
    const empty = await screen.findByText(/Nothing is assigned to you\./);
    expect(empty).toHaveTextContent(/^Nothing is assigned to you\. See all cases →$/);
  });
});
