import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";

const getWithHeaders = vi.fn();
const get = vi.fn();
const apiMock = { getWithHeaders, get };
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
  useAuth: () => ({ user: { role: "ROLE_ADMIN", email: "admin@example.com" } }),
}));

import CasesPage from "../page";

const baseCase = {
  caseId: "case-1",
  employeeId: "p-1",
  employeeName: "Ann Akana",
  site: "Kahului",
  measureId: "cms125",
  measureVersionId: "cms125",
  measureName: "Breast Cancer Screening",
  measureVersion: "1.0.000",
  evaluationPeriod: "2026-01-01",
  status: "CLOSED",
  priority: "HIGH",
  assignee: null,
  currentOutcomeStatus: "OVERDUE",
  lastRunId: "run-1",
  exclusionReason: null,
  waiverExpiresAt: null,
  waiverExpired: false,
  updatedAt: "2026-06-14T00:00:00Z",
  closedAt: "2026-06-14T00:00:00Z",
  closedReason: "MANUAL_RESOLVE",
  closedBy: "nurse@example.org",
  closure: "STAFF" as const,
};

const caseCalls = (): string[] =>
  getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/cases?"));

/** Reply with these rows plus the three staff-closed header counts. */
function respond(rows: unknown[], counts?: { gap: number; verified: number; unknown: number }) {
  getWithHeaders.mockReset().mockResolvedValue({
    data: rows,
    headers: new Headers({
      "X-Total-Count": String(rows.length),
      ...(counts
        ? {
            "X-Staff-Closed-Gap": String(counts.gap),
            "X-Staff-Closed-Verified": String(counts.verified),
            "X-Staff-Closed-Unknown": String(counts.unknown),
          }
        : {}),
    }),
  });
}

beforeEach(() => {
  navHolder.current.setUrl("/cases");
  get.mockReset().mockResolvedValue([]);
  respond([]);
});

describe("CasesPage — the Closed-by-staff tab (#569)", () => {
  it("asks the server for status=staff_closed when the tab is chosen", async () => {
    render(<CasesPage />);
    await waitFor(() => expect(caseCalls().length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: "Closed by staff" }));
    await waitFor(() => expect(caseCalls().at(-1)).toContain("status=staff_closed"));
  });

  it("opens straight onto the tab from a link, and shows the three counts from the headers", async () => {
    // The counts describe the WHOLE filtered list rather than the page, so they come from headers —
    // a tally of the rows on screen would under-report on every page but the last.
    respond([baseCase], { gap: 4, verified: 2, unknown: 1 });
    navHolder.current.setUrl("/cases?status=staff_closed");
    render(<CasesPage />);

    await waitFor(() => expect(caseCalls().at(-1)).toContain("status=staff_closed"));
    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.getByText(/still counted by CQL/)).toBeInTheDocument();
    expect(screen.getByText(/verified/)).toBeInTheDocument();
    // Shown, never folded into "verified": nothing has evaluated these patients.
    expect(screen.getByText(/not evaluated/)).toBeInTheDocument();
  });

  it("words a row by what CQL says TODAY, not by the closure alone", async () => {
    // GAP — a person closed it and the measure still counts the patient. This is the sentence the
    // whole change exists to put on screen.
    respond([{ ...baseCase, liveState: "GAP", liveOutcomeStatus: "OVERDUE", liveOutcomeRunId: "run-9" }], { gap: 1, verified: 0, unknown: 0 });
    navHolder.current.setUrl("/cases?status=staff_closed");
    const gapView = render(<CasesPage />);
    // `findAllBy`, not `findBy`: the page renders a row twice (a mobile list and a card grid, one
    // hidden by CSS), so the line legitimately appears more than once in the DOM.
    expect((await screen.findAllByText(/closed by nurse@example.org.*still counted by CQL/)).length).toBeGreaterThan(0);
    gapView.unmount();

    // CLEAR — a rerun-to-verify closure the measure corroborates. Saying "still counted by CQL" here
    // would be false, which is the defect two plan reviewers caught in the first wording.
    respond(
      [{ ...baseCase, status: "RESOLVED", closedReason: "RERUN_VERIFIED", liveState: "CLEAR", liveOutcomeStatus: "COMPLIANT" }],
      { gap: 0, verified: 1, unknown: 0 },
    );
    const clearView = render(<CasesPage />);
    expect((await screen.findAllByText(/verified compliant by nurse@example.org/)).length).toBeGreaterThan(0);
    // Scoped to the ROW's wording: the tab's own header line reads "N still counted by CQL · …" on
    // this tab whatever the rows say, so an unscoped negative assertion would be asserting that the
    // header does not exist.
    expect(screen.queryByText(/closed by nurse@example.org.*still counted by CQL/)).not.toBeInTheDocument();
    clearView.unmount();

    // UNKNOWN — no winning run has scored this patient. "Not evaluable" is neither of the above.
    respond([{ ...baseCase, liveState: "UNKNOWN", liveOutcomeStatus: null }], { gap: 0, verified: 0, unknown: 1 });
    render(<CasesPage />);
    expect((await screen.findAllByText(/current CQL status unavailable/)).length).toBeGreaterThan(0);
  });

  it("never calls an out-of-population row verified, and paints the chip to match", async () => {
    // CLEAR is three different facts and only two of them are a verification. A patient who fell out
    // of the measure's population carries the CANONICAL bucket MISSING_DATA, so a row that chose its
    // words from the canonical status alone would read "verified compliant" — crediting a person with
    // a result nobody produced — while its own chip said "Missing Data". The display status is what
    // both read, which is why the row carries it separately.
    respond(
      [{
        ...baseCase,
        liveState: "CLEAR",
        liveOutcomeStatus: "MISSING_DATA",
        liveDisplayStatus: "OUT_OF_POPULATION",
        liveOutcomeRunId: "run-9",
      }],
      { gap: 0, verified: 1, unknown: 0 },
    );
    navHolder.current.setUrl("/cases?status=staff_closed");
    render(<CasesPage />);

    expect((await screen.findAllByText(/outside this measure's population/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/verified compliant/)).not.toBeInTheDocument();
    // And the chip agrees with the sentence beside it rather than showing the frozen OVERDUE.
    expect(screen.getAllByText("Not in population").length).toBeGreaterThan(0);
    expect(screen.queryByText("Missing Data")).not.toBeInTheDocument();
  });

  it("offers no bulk action on a closed list — escalating a closed case would REOPEN it", async () => {
    // `escalateCase` writes `status: "OPEN"`, so an escalate from the staff-closed tab would silently
    // undo a closure a person made deliberately, with a reason, and no confirmation. Assigning would
    // merely answer 0. The affordance is therefore absent rather than failing politely.
    respond([baseCase], { gap: 1, verified: 0, unknown: 0 });
    navHolder.current.setUrl("/cases?status=staff_closed");
    const closedView = render(<CasesPage />);
    await screen.findAllByText("Ann Akana");
    expect(screen.queryByText("Select all in current results")).not.toBeInTheDocument();
    closedView.unmount();

    // The same seat on the OPEN list still gets it — the gate is the list, not the role.
    respond([{ ...baseCase, caseId: "case-open", status: "OPEN", closedAt: null, closedReason: null, closedBy: null, closure: "NONE" }]);
    navHolder.current.setUrl("/cases");
    render(<CasesPage />);
    await screen.findAllByText("Ann Akana");
    expect(screen.getAllByText("Select all in current results").length).toBeGreaterThan(0);
  });

  it("labels which KIND of closure a row on the plain Closed tab is", async () => {
    // `status` cannot say it: a manual close writes CLOSED, a rerun-verified close writes RESOLVED,
    // and the run's own auto-resolve writes RESOLVED too.
    respond([
      baseCase,
      { ...baseCase, caseId: "case-2", employeeId: "p-2", employeeName: "Ben Bright", status: "RESOLVED", closedReason: "AUTO_RESOLVED", closedBy: null, closure: "SYSTEM" },
    ]);
    navHolder.current.setUrl("/cases?status=closed");
    render(<CasesPage />);

    // Wait for a ROW, not for the words: "Closed by staff" is also the tab button's label, so a
    // `findBy` on it resolves against the initial render before any data has arrived — which is how
    // an earlier version of this test passed while asserting nothing about the rows.
    await screen.findAllByText("Ben Bright");
    expect(screen.getAllByTitle("A person closed this case").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("The nightly run closed this case").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Auto-resolved").length).toBeGreaterThan(0);
  });

  it("shows no closure line and no counts on the open list", async () => {
    respond([{ ...baseCase, caseId: "case-open", status: "OPEN", closedAt: null, closedReason: null, closedBy: null, closure: "NONE" }]);
    render(<CasesPage />);
    await screen.findAllByText("Ann Akana");

    expect(screen.queryByText(/still counted by CQL/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not evaluated/)).not.toBeInTheDocument();
    // By TITLE rather than by text: the tab button says "Closed by staff" too, and asserting on the
    // words would be asserting that the tab does not exist.
    expect(screen.queryByTitle("A person closed this case")).not.toBeInTheDocument();
    expect(screen.queryByTitle("The nightly run closed this case")).not.toBeInTheDocument();
  });
});
