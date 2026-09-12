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
  navHolder.current = createNavMock("/worklist");
  return navHolder.current.navigation;
});

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "2026-01-01", to: "2026-12-31" }),
}));
const emitToast = vi.fn();
vi.mock("@/lib/toast", () => ({ emitToast: (...args: unknown[]) => emitToast(...args) }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "quality-lead@maui.workwell.dev" } }),
}));

import WorklistPage from "../page";

const TWO_GAP_PATIENT = {
  employeeId: "maui-pat-00001",
  employeeName: "Lisa Carter",
  site: "Wailuku",
  providerId: "maui-prov-012",
  providerName: "NP Kira Venn",
  payer: "1",
  payerName: "Medicare",
  gapCount: 2,
  highestPriority: "HIGH",
  owner: null,
  assignees: [],
  updatedAt: "2026-09-11T00:00:00Z",
  openGaps: [
    { caseId: "case-1", measureId: "cms125", measureName: "Breast Cancer Screening", status: "OPEN", outcomeStatus: "OVERDUE", priority: "HIGH", assignee: null, nextAction: "Order a mammogram", evaluationPeriod: "2027-01-01", updatedAt: "2026-09-11T00:00:00Z" },
    { caseId: "case-2", measureId: "cms122", measureName: "Diabetes HbA1c", status: "OPEN", outcomeStatus: "DUE_SOON", priority: "MEDIUM", assignee: null, nextAction: "Order an HbA1c", evaluationPeriod: "2027-01-01", updatedAt: "2026-09-10T00:00:00Z" },
  ],
};

const PROVIDERS = [{ id: "maui-prov-012", name: "NP Kira Venn", location: "Wailuku" }];
const ASSIGNABLE = [
  { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
];
// Medicare is TWO codes on this roster — the case the multi-select exists for.
const PAYERS = [
  { code: "1", name: "Medicare", group: "1", groupName: "Medicare", subjectCount: 3927 },
  { code: "11", name: "Medicare Advantage", group: "1", groupName: "Medicare", subjectCount: 2900 },
  { code: "2", name: "Medicaid", group: "2", groupName: "Medicaid", subjectCount: 3277 },
  { code: "5", name: "Commercial", group: "5", groupName: "Commercial", subjectCount: 9896 },
];

const listCalls = (): string[] =>
  getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/worklist/patients"));

beforeEach(() => {
  navHolder.current.setUrl("/worklist");
  post.mockReset().mockResolvedValue({ assigned: 2, unchanged: 0, conflicted: 0, missing: [], closed: [] });
  emitToast.mockReset();
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/users/assignable")) return Promise.resolve(ASSIGNABLE);
    if (url.startsWith("/api/providers")) return Promise.resolve(PROVIDERS);
    if (url.startsWith("/api/payers")) return Promise.resolve(PAYERS);
    return Promise.resolve([]);
  });
  getWithHeaders.mockReset().mockResolvedValue({
    data: [TWO_GAP_PATIENT],
    headers: new Headers({ "X-Total-Count": "1" }),
  });
});

describe("WorklistPage", () => {
  it("renders ONE row per patient carrying every open gap", async () => {
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    expect(await screen.findByRole("link", { name: "Lisa Carter" })).toBeInTheDocument();
    // The two gaps are on the one row — that is the whole difference from /cases.
    expect(await screen.findByRole("link", { name: "Breast Cancer Screening" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Diabetes HbA1c" })).toBeInTheDocument();
    // And the row is one row, not two.
    expect(screen.getAllByRole("link", { name: "Lisa Carter" })).toHaveLength(1);
    // Singular for one. "1 patients with open gaps" is the kind of thing a pilot user screenshots.
    expect(screen.getByText(/1 (patient|employee) with open gaps/i)).toBeInTheDocument();
  });

  it("assigns every open gap of the selected PATIENTS in one call, and says so on the button", async () => {
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));
    // The button names the scope: one patient ticked, two gaps assigned. "Assign selected" would be
    // ambiguous about which of those numbers it means.
    const button = await screen.findByRole("button", { name: /assign 2 open gaps/i });
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));
    await userEvent.click(button);

    await waitFor(() => {
      const bulk = post.mock.calls.find((c) => String(c[0]).includes("/api/cases/bulk-assign"));
      expect(bulk).toBeDefined();
      expect(bulk![1]).toEqual({
        assignee: "quality-staff@maui.workwell.dev",
        caseIds: ["case-1", "case-2"],
      });
    });
  });

  it("offers insurance as a MULTI-select, because Medicare is two codes", async () => {
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    // Both Medicare codes are their own option, each with its count, so the split is visible rather
    // than something the operator has to know.
    const medicare = await screen.findByRole("checkbox", { name: /^Medicare \(3,927\)$/ });
    const advantage = screen.getByRole("checkbox", { name: /^Medicare Advantage \(2,900\)$/ });
    expect(medicare).toBeInTheDocument();
    expect(advantage).toBeInTheDocument();

    await userEvent.click(medicare);
    await waitFor(() => expect(listCalls().at(-1)).toContain("payer=1"));

    // Ticking the second code ADDS it rather than replacing — a single-select would have dropped the
    // first, handing back a list that omits 2,900 patients under a heading that says Medicare.
    await userEvent.click(screen.getByRole("checkbox", { name: /^Medicare Advantage \(2,900\)$/ }));
    await waitFor(() => {
      const last = listCalls().at(-1)!;
      expect(last).toContain("payer=1");
      expect(last).toContain("payer=11");
    });
  });

  it("'All Medicare' selects every code in the category that the roster actually has", async () => {
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    // One control for the question a staff member actually asks. The count on it is the category's,
    // not either code's.
    await userEvent.click(await screen.findByRole("button", { name: /all medicare \(6,827\)/i }));
    await waitFor(() => {
      const last = listCalls().at(-1)!;
      expect(last).toContain("payer=1");
      expect(last).toContain("payer=11");
      expect(last).not.toContain("payer=2&");
    });
    // Medicaid and Commercial are single-code categories, so they get no redundant "all" button.
    expect(screen.queryByRole("button", { name: /all medicaid/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /all commercial/i })).not.toBeInTheDocument();
  });

  it("hides the insurance filter entirely where the deployment records no payer", async () => {
    // The occupational roster has never carried one. An empty filter box invites a staff member to
    // wonder what they are missing; no filter says there is nothing to filter by.
    get.mockImplementation((url: string) => {
      if (url.startsWith("/api/users/assignable")) return Promise.resolve(ASSIGNABLE);
      if (url.startsWith("/api/providers")) return Promise.resolve(PROVIDERS);
      return Promise.resolve([]);
    });
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(screen.queryByRole("checkbox", { name: /medicare/i })).not.toBeInTheDocument();
  });

  it("reads the PCP filter from the URL and sends it on", async () => {
    navHolder.current.setUrl("/worklist?providerId=maui-prov-012");
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().at(-1)).toContain("providerId=maui-prov-012"));
  });

  it("shows 'Mixed' rather than one name when the gaps belong to different people", async () => {
    getWithHeaders.mockResolvedValue({
      data: [{ ...TWO_GAP_PATIENT, owner: "mixed", assignees: ["a@x.dev", "b@x.dev"] }],
      headers: new Headers({ "X-Total-Count": "1" }),
    });
    render(<WorklistPage />);
    // Naming one of the two would tell a caller that someone is handling the rest.
    expect(await screen.findByText(/mixed \(2\)/i)).toBeInTheDocument();
  });

  it("marks a gap that is not the filtered assignee's, so the count describes the list", async () => {
    navHolder.current.setUrl("/worklist?assignee=quality-lead%40maui.workwell.dev");
    getWithHeaders.mockResolvedValue({
      data: [{
        ...TWO_GAP_PATIENT,
        owner: "mixed",
        assignees: ["quality-lead@maui.workwell.dev"],
        openGaps: [
          { ...TWO_GAP_PATIENT.openGaps[0], assignee: "quality-lead@maui.workwell.dev" },
          { ...TWO_GAP_PATIENT.openGaps[1], otherAssignee: true },
        ],
      }],
      headers: new Headers({ "X-Total-Count": "1" }),
    });
    render(<WorklistPage />);
    const other = await screen.findByRole("link", { name: "Diabetes HbA1c" });
    // The patient is on the list because of the FIRST gap; the second is shown (one call can close
    // both) but marked as not the filtered assignee's.
    expect(other.getAttribute("title")).toMatch(/not the filtered assignee/i);
  });

  it("says gaps were SKIPPED rather than 'already assigned that way'", async () => {
    // A run can close a gap between the page load and the click. Reporting that as "already assigned
    // that way" is the one explanation that is definitely wrong, and the one that stops someone
    // looking further.
    post.mockResolvedValue({ assigned: 0, unchanged: 2, missing: ["gone"], closed: ["case-1"] });
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));
    await userEvent.click(await screen.findByRole("button", { name: /assign 2 open gaps/i }));

    await waitFor(() => expect(emitToast).toHaveBeenCalled());
    const message = String(emitToast.mock.calls.at(-1)![0]);
    expect(message).toMatch(/2 skipped/i);
    expect(message).not.toMatch(/already assigned that way/i);
  });

  it("refuses a selection too large for one request, and says why", async () => {
    // 100 patients per page on a deployment routing six measures is up to 600 gaps, over the server's
    // 500 cap. Without this the button reads "Assign 600 open gaps" and the click returns a raw 400.
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...TWO_GAP_PATIENT,
      employeeId: `p-${i}`,
      employeeName: `Patient ${i}`,
      gapCount: 5,
      openGaps: Array.from({ length: 5 }, (_, g) => ({ ...TWO_GAP_PATIENT.openGaps[0], caseId: `c-${i}-${g}` })),
    }));
    getWithHeaders.mockResolvedValue({ data: many, headers: new Headers({ "X-Total-Count": "120" }) });
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select all/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));

    expect(await screen.findByText(/too many for one assignment \(600 gaps, limit 500\)/i)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /assign 600 open gaps/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(post.mock.calls.filter((c) => String(c[0]).includes("bulk-assign"))).toHaveLength(0);
  });

  it("says how many of the selected gaps belong to someone else", async () => {
    getWithHeaders.mockResolvedValue({
      data: [{
        ...TWO_GAP_PATIENT,
        openGaps: [
          { ...TWO_GAP_PATIENT.openGaps[0], assignee: "someone.else@maui.workwell.dev" },
          TWO_GAP_PATIENT.openGaps[1],
        ],
      }],
      headers: new Headers({ "X-Total-Count": "1" }),
    });
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));
    // The list dims and labels those gaps; taking them without a word would undo that.
    expect(await screen.findByText(/1 of 2 currently belong to someone else/i)).toBeInTheDocument();
  });

  it("forwards the dashboard date range, so changing it is not a refetch that changes nothing", async () => {
    // The control renders on every dashboard page. It must apply here or not be read at all.
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().at(-1)).toContain("from=2026-01-01");
    expect(listCalls().at(-1)).toContain("to=2026-12-31");
  });

  it("clears the selection after a successful assign", async () => {
    // The patients keep their gaps, so they stay on the list. Leaving them selected keeps the action
    // bar live over work already done, and the only outcome of a second click is "no gaps changed".
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));
    await userEvent.click(await screen.findByRole("button", { name: /assign 2 open gaps/i }));

    await waitFor(() => expect(screen.queryByText(/selected/i)).not.toBeInTheDocument());
  });

  it("says 'Mixed (1 + unassigned)' rather than a count that contradicts the label", async () => {
    // `assignees` excludes the unassigned gaps, so "Mixed (1)" read as one owner for a patient whose
    // other gap belongs to nobody — hiding the gap that most needs picking up.
    getWithHeaders.mockResolvedValue({
      data: [{
        ...TWO_GAP_PATIENT,
        owner: "mixed",
        assignees: ["quality-lead@maui.workwell.dev"],
        openGaps: [
          { ...TWO_GAP_PATIENT.openGaps[0], assignee: "quality-lead@maui.workwell.dev" },
          TWO_GAP_PATIENT.openGaps[1],
        ],
      }],
      headers: new Headers({ "X-Total-Count": "1" }),
    });
    render(<WorklistPage />);
    expect(await screen.findByText(/mixed \(1 \+ unassigned\)/i)).toBeInTheDocument();
  });

  it("surfaces a load failure instead of rendering an empty list that reads as 'no work'", async () => {
    getWithHeaders.mockRejectedValue(new Error("upstream unavailable"));
    render(<WorklistPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/upstream unavailable/i);
  });

  it("says an assignment did NOT apply when somebody else moved the gap first", async () => {
    // The compare-and-set skips a row another operator reassigned while this one was choosing. Folding
    // that into "already assigned that way" tells them the opposite of what happened, and folding it
    // into "skipped" suggests the gap was closed or gone, which it is not.
    post.mockResolvedValueOnce({ assigned: 0, unchanged: 0, conflicted: 2, missing: [], closed: [] });
    render(<WorklistPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    await userEvent.click(await screen.findByRole("checkbox", { name: /select lisa carter/i }));
    const button = await screen.findByRole("button", { name: /assign 2 open gaps/i });
    await userEvent.click(await screen.findByRole("combobox", { name: /assignee for selected/i }));
    await userEvent.click(await screen.findByRole("option", { name: /quality-staff@maui\.workwell\.dev/i }));
    await userEvent.click(button);

    await waitFor(() =>
      expect(emitToast).toHaveBeenCalledWith(
        expect.stringContaining("reassigned by someone else"),
        "error",
      ),
    );
    expect(emitToast).not.toHaveBeenCalledWith(
      expect.stringContaining("already assigned that way"),
      expect.anything(),
    );
  });
});
