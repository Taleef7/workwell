import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";

const getWithHeaders = vi.fn();
const get = vi.fn();
// Keep the mocked client stable across renders, matching the real memoized useApi() client.
const apiMock = { getWithHeaders, get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

// Reactive router mock: push/replace update the params and re-render, like the real App Router.
const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/cases");
  return navHolder.current.navigation;
});

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN", email: "admin@example.com" } }),
}));

import CasesPage from "../page";

function caseCalls(): string[] {
  return getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/cases?"));
}

beforeEach(() => {
  navHolder.current.setUrl("/cases");
  get.mockReset().mockResolvedValue([]);
  getWithHeaders.mockReset().mockResolvedValue({
    data: [],
    headers: new Headers({ "X-Total-Count": "0" }),
  });
});

describe("CasesPage URL filters", () => {
  it("reads measureId and outcome from the URL and sends them to /api/cases", async () => {
    navHolder.current.setUrl("/cases?measureId=cms125&outcome=OVERDUE");
    render(<CasesPage />);
    await waitFor(() => {
      const caseCall = caseCalls().at(-1);
      expect(caseCall).toContain("measureId=cms125");
      expect(caseCall).toContain("outcome=OVERDUE");
    });
  });

  it("refetches with the new filter when the URL changes externally (back/forward)", async () => {
    navHolder.current.setUrl("/cases?measureId=cms125&outcome=OVERDUE");
    render(<CasesPage />);
    await waitFor(() => {
      expect(caseCalls().some((u) => u.includes("outcome=OVERDUE"))).toBe(true);
    });
    // Simulate the browser back button: the URL changes with no navigation handler involved.
    act(() => navHolder.current.setUrl("/cases?measureId=cms125&outcome=DUE_SOON"));
    await waitFor(() => {
      const latest = caseCalls().at(-1);
      expect(latest).toContain("outcome=DUE_SOON");
      expect(latest).not.toContain("outcome=OVERDUE");
    });
  });

  it("changing the outcome select writes the URL and refetches", async () => {
    render(<CasesPage />);
    await waitFor(() => expect(caseCalls().length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("combobox", { name: /outcome/i }));
    await userEvent.click(screen.getByRole("option", { name: /overdue/i }));
    await waitFor(() => {
      expect(navHolder.current.params.get("outcome")).toBe("OVERDUE");
      expect(caseCalls().at(-1)).toContain("outcome=OVERDUE");
    });
  });

  it("ignores an unknown outcome value rather than sending it", async () => {
    navHolder.current.setUrl("/cases?outcome=NOT_A_STATUS");
    render(<CasesPage />);
    await waitFor(() => {
      const caseCall = caseCalls().at(-1);
      expect(caseCall).toBeDefined();
      expect(caseCall).not.toContain("outcome=");
    });
  });
});

describe("CasesPage — one row per gap, with the work list as the daily screen (#698)", () => {
  it("no longer calls itself the daily worklist, and links to the work list with the measure and status", async () => {
    navHolder.current.setUrl("/cases?measureId=cms125&outcome=OVERDUE");
    render(<CasesPage />);
    const link = await screen.findByRole("link", { name: /on the work list/i });
    expect(link).toHaveAttribute("href", "/worklist?measureId=cms125&outcome=OVERDUE&panel=all");
    expect(screen.queryByText(/your daily worklist/i)).toBeNull();
    expect(screen.getByText(/one row per gap: the open cases by default/i)).toBeInTheDocument();
  });
});

describe("CasesPage — the work list link keeps the PCP, the search and the closed-by-staff view (#698 review)", () => {
  it("carries providerId and search", async () => {
    navHolder.current.setUrl("/cases?measureId=cms125&providerId=pcp-7&search=smith");
    render(<CasesPage />);
    expect(await screen.findByRole("link", { name: /on the work list/i })).toHaveAttribute(
      "href",
      "/worklist?measureId=cms125&providerId=pcp-7&search=smith&panel=all",
    );
  });

  it("from the closed-by-staff tab, opens the work list's closed-by-staff view", async () => {
    navHolder.current.setUrl("/cases?status=staff_closed&measureId=cms125");
    render(<CasesPage />);
    expect(await screen.findByRole("link", { name: /on the work list/i })).toHaveAttribute("href", "/worklist?measureId=cms125&status=staff_closed&panel=all");
  });
});

describe("CasesPage — the work list link is the same cohort (#742 review)", () => {
  it("'My Cases' carries over as the work list's assignee filter", async () => {
    navHolder.current.setUrl("/cases?view=mine&measureId=cms125");
    render(<CasesPage />);
    expect(await screen.findByRole("link", { name: /on the work list/i })).toHaveAttribute(
      "href",
      "/worklist?measureId=cms125&assignee=admin%40example.com&panel=all",
    );
  });
});

describe("CasesPage — the Excluded tab says what it counts (#655)", () => {
  it("explains it lists cases a run closed as excluded, unlike the Programs count", async () => {
    navHolder.current.setUrl("/cases?status=excluded");
    render(<CasesPage />);
    const note = await screen.findByTestId("excluded-tab-note");
    expect(note).toHaveTextContent(/Cases a run closed because the \w+ became excluded/);
    expect(note).toHaveTextContent(/differs from the .Excluded. count on Programs/);
  });

  it("says nothing of the kind on the other tabs", async () => {
    navHolder.current.setUrl("/cases?status=open");
    render(<CasesPage />);
    await screen.findByRole("group", { name: "Status" });
    expect(screen.queryByTestId("excluded-tab-note")).toBeNull();
  });
});
