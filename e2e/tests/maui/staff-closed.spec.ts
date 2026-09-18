/**
 * A case a person closed is still visible as a gap CQL counts (#569, ADR-083) — asserted on the
 * sandbox against ONE DESIGNATED CLOSURE, by id.
 *
 * Why by id, rather than "the staff-closed tab returns a number" or "the chip renders": every such
 * assertion is satisfied by ZERO. The tab would be green while empty, the chip green while it said 0,
 * and the whole feature could be broken without a single failure. So the sandbox carries one closure
 * made deliberately for this check (recorded in `docs/JOURNAL.md`), and every assertion below names
 * it. If the feature regresses, these fail; if the fixture disappears, they fail loudly and say so.
 *
 * Read-only: this spec makes no writes. The closure it reads was made once, by hand, as an approved
 * one-off — there is no reopen path, so it stays closed for the cycle by design.
 */
import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, MAUI_PASSWORD, API_BASE } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

/**
 * The designated closure. Closed 2026-09-18 by the admin seat with a note, immediately after #569
 * deployed; see the 2026-09-18 JOURNAL entry.
 *
 * **It expires at cycle rollover, and that is a loud failure by design.** A closed case is never
 * touched by the run again — the rollover close-out only reaches OPEN/IN_PROGRESS rows — so when the
 * measurement year turns this row becomes history and a NEW case is inserted for the same patient.
 * The cycle-scoped surfaces (the roster marker, the programs chip, the default staff-closed tab) then
 * correctly stop naming it. The first test below detects exactly that and tells the operator to
 * designate a fresh closure rather than letting the rest fail as if the feature broke.
 */
const DESIGNATED = {
  caseId: "ffce1e30-5ffb-48cd-b9d6-862876d310fb",
  subjectId: "pat-19735",
  measureId: "cms130",
  evaluationPeriod: "2026-01-01",
  closedBy: "admin@maui.workwell.dev",
} as const;

interface CaseRow {
  caseId: string;
  employeeId: string;
  measureId: string;
  evaluationPeriod: string;
  status: string;
  closure: string;
  closedBy: string | null;
  closedReason: string | null;
  currentOutcomeStatus: string | null;
  liveState: string | null;
  liveOutcomeStatus: string | null;
  liveOutcomeRunId: string | null;
}

async function token(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const login = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
  });
  expect(login.ok(), "the quality-lead seat must sign in").toBe(true);
  return ((await login.json()) as { token: string }).token;
}

test.describe("Maui — the designated staff closure stays visible as a gap", () => {
  test("the fixture is still a STAFF closure of the cycle the surfaces describe", async ({ request }) => {
    const auth = { Authorization: `Bearer ${await token(request)}` };
    const res = await request.get(
      `${API_BASE}/api/cases?status=staff_closed&period=all&limit=500`,
      { headers: auth },
    );
    expect(res.status()).toBe(200);
    const rows = (await res.json()) as CaseRow[];
    const row = rows.find((r) => r.caseId === DESIGNATED.caseId);

    expect(
      row,
      `The designated closure ${DESIGNATED.caseId} is gone from the sandbox. This spec cannot check ` +
        `#569 without it: close one synthetic case as admin, record the id in docs/JOURNAL.md, and ` +
        `update DESIGNATED here.`,
    ).toBeTruthy();
    expect(row!.closure, "closed_by is set, so this is a STAFF closure — not the run's").toBe("STAFF");
    expect(row!.closedBy).toBe(DESIGNATED.closedBy);
    expect(
      row!.evaluationPeriod,
      `The designated closure belongs to ${row!.evaluationPeriod}, and the cycle has moved on. The ` +
        `cycle-scoped surfaces (roster marker, programs chip) correctly no longer name it. Designate ` +
        `a fresh closure in the current cycle and update DESIGNATED.`,
    ).toBe(DESIGNATED.evaluationPeriod);
  });

  test("it is ON the staff-closed list, OFF the open list, and the run still counts the patient", async ({ request }) => {
    const auth = { Authorization: `Bearer ${await token(request)}` };

    const closed = await request.get(`${API_BASE}/api/cases?status=staff_closed&limit=500`, { headers: auth });
    expect(closed.status()).toBe(200);
    const closedRows = (await closed.json()) as CaseRow[];
    const row = closedRows.find((r) => r.caseId === DESIGNATED.caseId);
    expect(row, "the designated closure is on the staff-closed tab").toBeTruthy();

    // The point of the whole change: the case row's own status froze at closure, and the LIVE answer
    // comes from the winning run. Both are reported, and they are allowed to differ.
    expect(row!.liveState, "CQL still counts this patient").toBe("GAP");
    expect(row!.liveOutcomeStatus).toBe("OVERDUE");
    expect(row!.liveOutcomeRunId, "and the answer names the run it came from").toBeTruthy();
    expect(row!.currentOutcomeStatus, "the frozen value keeps its own column").toBe("OVERDUE");

    // The header counts describe the WHOLE list, not the page — a tally of the rows on screen would
    // under-report on every page but the last.
    expect(Number(closed.headers()["x-staff-closed-gap"] ?? 0)).toBeGreaterThanOrEqual(1);

    // And it really has left the work list, which is the defect that started this.
    const open = await request.get(`${API_BASE}/api/cases?status=open&limit=500`, { headers: auth });
    expect(open.status()).toBe(200);
    const openRows = (await open.json()) as CaseRow[];
    expect(openRows.some((r) => r.caseId === DESIGNATED.caseId), "a closed case is not an open case").toBe(false);
  });

  test("the roster marks the cell and does not change its status", async ({ request }) => {
    const auth = { Authorization: `Bearer ${await token(request)}` };
    const res = await request.get(
      `${API_BASE}/api/compliance/roster?measureId=${DESIGNATED.measureId}&q=${DESIGNATED.subjectId}&pageSize=25`,
      { headers: auth },
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { rows?: Array<Record<string, unknown>> };
    const rows = body.rows ?? [];
    expect(rows.length, `the roster must find ${DESIGNATED.subjectId}`).toBeGreaterThan(0);

    const cells = rows[0]!.cells as Record<string, Record<string, unknown>> | undefined;
    const cell = cells?.[DESIGNATED.measureId];
    expect(cell, `the ${DESIGNATED.measureId} cell must render`).toBeTruthy();

    const closure = cell!.staffClosure as { closedBy?: string } | undefined;
    expect(closure, "the cell carries the closure marker").toBeTruthy();
    expect(closure!.closedBy).toBe(DESIGNATED.closedBy);
    // The overlay is ADDITIVE. If it changed `status`, every chip count and the `?status=` filter
    // would move with it — the marker exists precisely so the numbers do not.
    expect(cell!.status, "the CQL status is untouched by the closure").toBe("OVERDUE");
    expect(cell!.evaluationPeriod).toBe(DESIGNATED.evaluationPeriod);
  });

  test("the programs card accounts for the difference between its own two numbers", async ({ request }) => {
    const auth = { Authorization: `Bearer ${await token(request)}` };
    const res = await request.get(`${API_BASE}/api/programs`, { headers: auth, timeout: 60_000 });
    expect(res.status()).toBe(200);
    const cards = (await res.json()) as Array<{
      measureId: string;
      overdue: number;
      openCaseCount: number;
      staffClosedGapCount: number;
    }>;
    const card = cards.find((c) => c.measureId === DESIGNATED.measureId);
    expect(card, `${DESIGNATED.measureId} must have a card`).toBeTruthy();

    // The contradiction #569 exists to close: this patient is in Overdue (outcome-derived) and absent
    // from the open-case count (ACTIVE cases only). Both numbers were right and they disagreed, with
    // nothing on the page saying why. The chip is what says why, so it must not be zero.
    expect(card!.staffClosedGapCount, "the chip names at least the designated closure").toBeGreaterThanOrEqual(1);
    expect(card!.overdue).toBeGreaterThan(card!.openCaseCount);

    // And the chip EQUALS the tab it links to, under the same filters. A chip that merely renders a
    // plausible number beside a tab showing a different one is the defect in a new place: the chip is
    // an invitation to click, and the count has to survive the click. `?status=staff_closed` defaults
    // to the current cycle, which is the cycle the chip counts.
    const tab = await request.get(
      `${API_BASE}/api/cases?status=staff_closed&measureId=${DESIGNATED.measureId}&limit=500`,
      { headers: auth },
    );
    expect(tab.status()).toBe(200);
    const tabGaps = ((await tab.json()) as CaseRow[]).filter((r) => r.liveState === "GAP").length;
    expect(tabGaps, "the chip's number is the tab's number").toBe(card!.staffClosedGapCount);
    expect(Number(tab.headers()["x-staff-closed-gap"] ?? -1), "and the header agrees with both").toBe(tabGaps);
  });

  test("the CSV carries the closure and the live answer, in the five appended columns", async ({ request }) => {
    const auth = { Authorization: `Bearer ${await token(request)}` };
    const res = await request.get(`${API_BASE}/api/exports/cases?format=csv&status=staff_closed`, {
      headers: auth,
      timeout: 150_000,
    });
    expect(res.status()).toBe(200);
    const lines = (await res.text()).trim().split(/\r?\n/);
    const headers = lines[0]!.split(",").map((h) => h.trim());

    // APPENDED, never inserted (§6.3): a consumer reading by position keeps every column it had.
    expect(headers.slice(-5)).toEqual([
      "closedReason", "closedBy", "liveState", "liveOutcomeStatus", "liveOutcomeRunId",
    ]);

    const row = lines.slice(1).map((l) => l.split(",")).find((c) => c[0] === DESIGNATED.caseId);
    expect(row, "the designated closure is a row of the export").toBeTruthy();
    const cell = (name: string) => row![headers.indexOf(name)]?.trim();
    expect(cell("closedBy")).toBe(DESIGNATED.closedBy);
    expect(cell("closedReason")).toBe("MANUAL_RESOLVE");
    expect(cell("liveState"), "the reconciliation column").toBe("GAP");
    expect(cell("liveOutcomeStatus")).toBe("OVERDUE");
    expect(cell("liveOutcomeRunId")).toBeTruthy();
  });
});
