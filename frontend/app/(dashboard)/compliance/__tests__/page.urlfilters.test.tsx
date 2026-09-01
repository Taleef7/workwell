import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  navHolder.current = createNavMock("/compliance");
  return navHolder.current.navigation;
});

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

import CompliancePage from "../page";

function rosterCalls(): string[] {
  return getWithHeaders.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith("/api/compliance/roster?"));
}

beforeEach(() => {
  navHolder.current.setUrl("/compliance");
  get.mockReset().mockResolvedValue([]);
  getWithHeaders.mockReset().mockImplementation((url: string) => {
    const match = /panel=(\w+)/.exec(String(url));
    const panel = match ? match[1] : "immunizations";
    return Promise.resolve({
      data: { panel, columns: [], rows: [] },
      headers: new Headers({ "X-Total-Count": "0" }),
    });
  });
});
afterEach(() => vi.clearAllMocks());

describe("CompliancePage URL filters", () => {
  it("reads status and panel from the URL and sends them to the roster request", async () => {
    navHolder.current.setUrl("/compliance?status=COMPLIANT&panel=wellness");
    render(<CompliancePage />);
    await waitFor(() => {
      const rosterCall = rosterCalls().at(-1);
      expect(rosterCall).toContain("status=COMPLIANT");
      expect(rosterCall).toContain("panel=wellness");
    });
  });

  it("refetches with the new status when the URL changes externally (back/forward)", async () => {
    navHolder.current.setUrl("/compliance?status=COMPLIANT");
    render(<CompliancePage />);
    await waitFor(() => {
      expect(rosterCalls().at(-1)).toContain("status=COMPLIANT");
    });
    act(() => navHolder.current.setUrl("/compliance?status=EXCLUDED"));
    await waitFor(() => {
      const latest = rosterCalls().at(-1);
      expect(latest).toContain("status=EXCLUDED");
      expect(latest).not.toContain("status=COMPLIANT");
    });
  });

  it("changing the status select writes the URL and refetches", async () => {
    render(<CompliancePage />);
    await waitFor(() => expect(rosterCalls().length).toBeGreaterThan(0));
    await userEvent.selectOptions(screen.getByLabelText(/Status/i), "OVERDUE");
    await waitFor(() => {
      expect(navHolder.current.params.get("status")).toBe("OVERDUE");
      expect(rosterCalls().at(-1)).toContain("status=OVERDUE");
    });
  });

  it("drops an unknown status value rather than sending it", async () => {
    navHolder.current.setUrl("/compliance?status=NOT_A_STATUS");
    render(<CompliancePage />);
    await waitFor(() => {
      const latest = rosterCalls().at(-1);
      expect(latest).toBeDefined();
      expect(latest).not.toContain("status=");
    });
  });

  it("falls back to the default panel on an unknown panel value", async () => {
    navHolder.current.setUrl("/compliance?panel=NOT_A_PANEL");
    render(<CompliancePage />);
    await waitFor(() => {
      expect(rosterCalls().at(-1)).toContain("panel=immunizations");
    });
  });

  it("canonicalizes the URL to the served panel when the server responds with a different panel", async () => {
    navHolder.current.setUrl("/compliance?panel=immunizations");
    getWithHeaders.mockReset().mockResolvedValue({
      data: { panel: "wellness", availablePanels: ["wellness"], columns: [], rows: [] },
      headers: new Headers({ "X-Total-Count": "0" }),
    });
    render(<CompliancePage />);
    await waitFor(() => {
      expect(navHolder.current.params.get("panel")).toBe("wellness");
      expect(navHolder.current.replace).toHaveBeenCalledWith("/compliance?panel=wellness");
      expect(navHolder.current.push).not.toHaveBeenCalled();
    });
  });
});
