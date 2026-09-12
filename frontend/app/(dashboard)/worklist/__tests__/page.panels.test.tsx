import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
const apiMock = { getWithHeaders, get, post, put, delete: del };
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

const VIEWER = vi.hoisted(() => ({ current: "quality-staff@maui.workwell.dev" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: VIEWER.current } }),
}));

import WorklistPage from "../page";

const PATIENT = {
  employeeId: "maui-pat-00001",
  employeeName: "Lisa Carter",
  site: "Wailuku",
  providerId: "maui-prov-012",
  providerName: "NP Kira Venn",
  payer: "1",
  payerName: "Medicare",
  gapCount: 1,
  highestPriority: "HIGH",
  owner: null,
  assignees: [],
  updatedAt: "2026-09-11T00:00:00Z",
  openGaps: [
    {
      caseId: "case-1",
      measureId: "cms125",
      measureName: "Breast Cancer Screening",
      status: "OPEN",
      outcomeStatus: "OVERDUE",
      priority: "HIGH",
      assignee: null,
      nextAction: "Order a mammogram",
      evaluationPeriod: "2027-01-01",
      updatedAt: "2026-09-11T00:00:00Z",
    },
  ],
};

const PROVIDERS = [
  { id: "maui-prov-012", name: "NP Kira Venn", location: "Wailuku" },
  { id: "maui-prov-013", name: "Dr Oren Tide", location: "Kihei" },
];
const ASSIGNABLE = [
  { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
];

/** One mapped panel (this staffer's) and one nobody owns — the two rows that matter. */
const MAPPED_PANELS = () => [
  {
    providerId: "maui-prov-012",
    providerName: "NP Kira Venn",
    location: "Wailuku",
    patients: 412,
    assignee: "quality-staff@maui.workwell.dev",
    updatedAt: "2026-09-12T00:00:00Z",
  },
  {
    providerId: "maui-prov-013",
    providerName: "Dr Oren Tide",
    location: "Kihei",
    patients: 388,
    assignee: null,
    updatedAt: null,
  },
];
const PANELS = { current: MAPPED_PANELS() as unknown[] };

const listCalls = (): string[] =>
  getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/worklist/patients"));

beforeEach(() => {
  navHolder.current.setUrl("/worklist");
  VIEWER.current = "quality-staff@maui.workwell.dev";
  PANELS.current = MAPPED_PANELS();
  post.mockReset().mockResolvedValue({ assigned: 1, unchanged: 0, conflicted: 0, missing: [], closed: [] });
  put.mockReset().mockResolvedValue({
    providerId: "maui-prov-013",
    providerName: "Dr Oren Tide",
    assignee: "quality-staff@maui.workwell.dev",
    previousAssignee: null,
    changed: true,
    backfillPlanned: 212,
    backfilled: 212,
  });
  del.mockReset().mockResolvedValue({ providerId: "maui-prov-012", previousAssignee: "quality-staff@maui.workwell.dev" });
  emitToast.mockReset();
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/users/assignable")) return Promise.resolve(ASSIGNABLE);
    if (url.startsWith("/api/providers")) return Promise.resolve(PROVIDERS);
    if (url.startsWith("/api/panels")) return Promise.resolve(PANELS.current);
    if (url.startsWith("/api/payers")) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  getWithHeaders.mockReset().mockResolvedValue({
    data: [PATIENT],
    headers: new Headers({ "X-Total-Count": "1", "X-Panel-Providers": "maui-prov-012" }),
  });
});

describe("the work list's default view", () => {
  it("opens on MY PANEL for a staffer who owns one, and names the panel", async () => {
    // The practice divides work by provider, so someone mapped to a provider should land on their own
    // patients rather than on several thousand of everyone else's.
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().some((u) => u.includes("panel=me"))).toBe(true));
    // Named, not just "My panel" — a staffer should see WHICH panels they are being shown.
    expect(await screen.findByText(/My panel: NP Kira Venn/)).toBeInTheDocument();
  });

  it("opens on the WHOLE PRACTICE for a supervisor who owns none", async () => {
    // The practice's own split: line staff work their providers, supervisors want to see everything.
    // Defaulting an unmapped supervisor to an empty panel would read as "no work".
    VIEWER.current = "quality-lead@maui.workwell.dev";
    render(<WorklistPage />);
    // Wait for the MAPPINGS, not merely for a first request. An earlier version asserted as soon as
    // any list call existed, which the page always makes without `panel=me` while ownership is still
    // unknown — so the assertion passed before the decision it claims to test had been made, and
    // would have passed with the rule inverted.
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/panels"));
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().every((u) => !u.includes("panel=me"))).toBe(true);
    expect(screen.queryByText(/My panel:/)).not.toBeInTheDocument();
  });

  it("asks for nothing until it knows whose list to ask for", async () => {
    // Without this the first paint of a mapped staffer was a whole-practice query — several thousand
    // other people's patients, shown and then replaced — followed by a second heavy query for the
    // panel. Every list request this page makes describes the view it has already decided on.
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().every((u) => u.includes("panel=me"))).toBe(true);
  });

  it("honours an explicit whole-practice choice even for someone who owns a panel", async () => {
    // Otherwise a mapped staffer could never look at the practice: the default would keep pulling them
    // back to their own list.
    navHolder.current.setUrl("/worklist?panel=all");
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().every((u) => !u.includes("panel=me"))).toBe(true);
  });

  it("says so when the viewer's panel is empty, rather than looking like a page that found nothing", async () => {
    PANELS.current = [];
    navHolder.current.setUrl("/worklist?panel=me");
    getWithHeaders.mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(await screen.findByText(/My panel: none assigned to me/)).toBeInTheDocument();
  });
});

describe("the Panels tab", () => {
  const openPanels = async () => {
    render(<WorklistPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "Panels" }));
  };

  it("loads the panel list ONCE for the page and the tab together", async () => {
    // Two copies of the hook meant two requests and, worse, a save in the tab that left the page's
    // own "My panel" chip describing the mappings as they were before the save.
    await openPanels();
    await waitFor(() => expect(screen.getByText("Dr Oren Tide")).toBeInTheDocument());
    expect(get.mock.calls.filter((c) => String(c[0]).startsWith("/api/panels"))).toHaveLength(1);
  });

  it("lists every provider, unmapped ones included, with the panel size", async () => {
    await openPanels();
    // The unowned panel is the row the screen exists to show; hiding it would defeat the purpose.
    expect(await screen.findByText("Dr Oren Tide")).toBeInTheDocument();
    expect(screen.getByText("NP Kira Venn")).toBeInTheDocument();
    expect(screen.getByText("412")).toBeInTheDocument();
    expect(screen.getByText(/1 panel has no owner/)).toBeInTheDocument();
  });

  it("saving an owner reports the gaps that MOVED, not just 'saved'", async () => {
    await openPanels();
    await userEvent.click(await screen.findByRole("combobox", { name: /worked by, dr oren tide/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toBe("/api/panels/maui-prov-013");
    expect(put.mock.calls[0]![1]).toEqual({ assignee: "quality-staff@maui.workwell.dev" });
    // 212 open gaps quietly changed hands. A toast that said "Saved" would hide the part that matters.
    await waitFor(() =>
      expect(emitToast).toHaveBeenCalledWith(expect.stringContaining("212 open gaps moved"), "success"),
    );
  });

  it("unassigning a panel says that open gaps keep their owner", async () => {
    // The surprising half of ADR-080 d4, so the screen states it rather than leaving staff to discover
    // whether a few hundred cases moved.
    await openPanels();
    await userEvent.click(await screen.findByRole("button", { name: "Unassign" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/panels/maui-prov-012"));
    await waitFor(() =>
      expect(emitToast).toHaveBeenCalledWith(
        expect.stringContaining("Open gaps keep their current owner"),
        "success",
      ),
    );
  });
});
