import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
  navHolder.current = createNavMock("/cases");
  return navHolder.current.navigation;
});

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "quality-lead@maui.workwell.dev" } }),
}));

import CasesPage from "../page";

const ONE_CASE = {
  caseId: "case-1",
  employeeId: "maui-pat-00001",
  employeeName: "Lisa Carter",
  site: "Wailuku",
  measureId: "cms125",
  measureVersionId: "cms125",
  measureName: "Breast Cancer Screening",
  measureVersion: "v14",
  evaluationPeriod: "2027-01-01",
  status: "OPEN",
  priority: "MEDIUM",
  assignee: null,
  currentOutcomeStatus: "OVERDUE",
  lastRunId: "run-1",
  exclusionReason: null,
  waiverExpiresAt: null,
  waiverExpired: false,
  updatedAt: "2026-09-11T00:00:00Z",
};

const ASSIGNABLE = [
  { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
];

const PROVIDERS = [
  { id: "maui-prov-003", name: "Dr. Aven Stone", location: "Kahului" },
  { id: "maui-prov-012", name: "NP Kira Venn", location: "Wailuku" },
];

function caseCalls(): string[] {
  return getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/cases?"));
}

beforeEach(() => {
  navHolder.current.setUrl("/cases");
  post.mockReset().mockResolvedValue(undefined);
  // The page pulls its own reference data: measures, assignable users and providers.
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/users/assignable")) return Promise.resolve(ASSIGNABLE);
    if (url.startsWith("/api/providers")) return Promise.resolve(PROVIDERS);
    return Promise.resolve([]);
  });
  getWithHeaders.mockReset().mockResolvedValue({
    data: [ONE_CASE],
    headers: new Headers({ "X-Total-Count": "1" }),
  });
});

describe("CasesPage assignment control", () => {
  // The pilot's quality staffer could not assign from the work list at all: the bulk control was a
  // free-text input with no datalist, so typing a name offered nothing and matched nothing. The
  // control must offer the assignable accounts rather than expect the operator to know an email.
  it("offers the assignable accounts as options once cases are selected", async () => {
    render(<CasesPage />);
    await waitFor(() => expect(caseCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));

    const control = await screen.findByRole("combobox", { name: /assignee for selected/i });
    await userEvent.click(control);
    expect(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /unassign/i })).toBeInTheDocument();
  });

  it("assigns the selected cases to the account chosen from the list", async () => {
    render(<CasesPage />);
    await waitFor(() => expect(caseCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));
    await userEvent.click(screen.getByRole("button", { name: /^assign/i }));

    // ONE request for the whole selection, not one per case. The loop this replaced had no
    // transaction around it, so a failure partway left some cases assigned and a toast that said
    // nothing about it.
    await waitFor(() => {
      const bulk = post.mock.calls.find((c) => String(c[0]).includes("/api/cases/bulk-assign"));
      expect(bulk).toBeDefined();
      expect(bulk![1]).toEqual({ assignee: "quality-staff@maui.workwell.dev", caseIds: ["case-1"] });
    });
    // And no per-case assign survives alongside it — otherwise both paths would be live and only one
    // of them audited the way the bulk endpoint does.
    expect(post.mock.calls.map((c) => String(c[0])).filter((u) => /\/api\/cases\/[^/]+\/assign$/.test(u))).toEqual([]);
  });

  it("clearing the assignee sends an explicit null rather than an empty string", async () => {
    render(<CasesPage />);
    await waitFor(() => expect(caseCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /unassign/i }));
    await userEvent.click(screen.getByRole("button", { name: /^assign/i }));

    // `null` is "clear the assignment"; `""` would be a value the server has to guess about.
    await waitFor(() => {
      const bulk = post.mock.calls.find((c) => String(c[0]).includes("/api/cases/bulk-assign"));
      expect(bulk![1]).toEqual({ assignee: null, caseIds: ["case-1"] });
    });
  });
});

describe("CasesPage PCP filter", () => {
  it("reads providerId from the URL and sends it to /api/cases", async () => {
    navHolder.current.setUrl("/cases?providerId=maui-prov-012");
    render(<CasesPage />);
    await waitFor(() => expect(caseCalls().at(-1)).toContain("providerId=maui-prov-012"));
  });

  it("choosing a PCP writes the URL and refetches", async () => {
    render(<CasesPage />);
    await waitFor(() => expect(caseCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("combobox", { name: /pcp|provider/i }));
    await userEvent.click(await screen.findByRole("option", { name: /kira venn/i }));

    await waitFor(() => {
      expect(navHolder.current.params.get("providerId")).toBe("maui-prov-012");
      expect(caseCalls().at(-1)).toContain("providerId=maui-prov-012");
    });
  });

  it("does not forward an empty providerId as a filter", async () => {
    navHolder.current.setUrl("/cases?providerId=");
    render(<CasesPage />);
    await waitFor(() => {
      const call = caseCalls().at(-1);
      expect(call).toBeDefined();
      expect(call).not.toContain("providerId=");
    });
  });
});
