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
