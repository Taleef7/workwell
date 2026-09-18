/**
 * "Closed by staff" (#569) — the token, the live-status resolution, and the three counts.
 *
 * The defect: an operator marks a case resolved with a reason, the row leaves the work list, and CQL
 * keeps counting that patient as a gap with nothing on screen saying so. The row's own
 * `current_outcome_status` cannot say it either — the nightly upsert no-ops on a human closure, so
 * the value is frozen at the moment of closure. Hence `withLiveStatus`, and hence these tests.
 *
 * node --import tsx --test src/case/staff-closed.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import {
  loadWorklistCases, worklistQueryFor, withLiveStatus, staffClosedCounts,
  STAFF_CLOSED_TOKEN, STAFF_CLOSED_STATUSES, type WorklistDeps,
} from "./worklist-read-model.ts";
import { ACTIVE_CASE_STATUSES, closureKindOf } from "./case-logic.ts";
import { toCaseSummary, type CaseSummary } from "./case-read-models.ts";
import type { CaseRecord } from "../stores/case-store.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { LiveCellDeps } from "../compliance/live-cell.ts";
import type { OutcomeRecord, OutcomeWithRun } from "../stores/outcome-store.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const CYCLE = bucketPeriodForMeasure("audiogram", TODAY);
const dbPath = join(tmpdir(), `workwell-staffclosed-${crypto.randomUUID()}.sqlite`);
let cases: SqliteCaseStore;
let events: SqliteCaseEventStore;
let runId: string;

const ROSTER: EmployeeProfile[] = [
  { externalId: "p-gap", name: "Ann Akana", role: "Patient", site: "Kahului", providerId: "prov-a", tenantId: "maui", payer: "1" },
  { externalId: "p-verified", name: "Ben Bright", role: "Patient", site: "Kahului", providerId: "prov-a", tenantId: "maui", payer: "1" },
  { externalId: "p-unknown", name: "Cara Chun", role: "Patient", site: "Kihei", providerId: "prov-b", tenantId: "maui", payer: "5" },
  { externalId: "p-open", name: "Dan Diaz", role: "Patient", site: "Kihei", providerId: "prov-b", tenantId: "maui", payer: "2" },
  { externalId: "p-auto", name: "Eve Ewing", role: "Patient", site: "Kihei", providerId: "prov-b", tenantId: "maui", payer: "2" },
];
const lookup = (id: string): EmployeeProfile | null => ROSTER.find((e) => e.externalId === id) ?? null;
const deps = (over: Partial<WorklistDeps> = {}): WorklistDeps =>
  ({ cases, events, employeeLookup: lookup, roster: () => ROSTER, today: () => TODAY, ...over });

/** The winning run's rows for the live lookup: a gap, a compliant one, and nothing for `p-unknown`. */
const ev = (status: string) => ({ expressionResults: [{ define: "Outcome Status", result: status }] });
const WINNERS: OutcomeWithRun[] = [{
  runId: "win-1", runStartedAt: "2026-06-13T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED",
  runTriggeredBy: "manual", subjectId: "p-gap", measureId: "audiogram", status: "OVERDUE",
}];
const WIN_ROWS: OutcomeRecord[] = [
  { id: "w-1", runId: "win-1", subjectId: "p-gap", measureId: "audiogram", evaluationPeriod: CYCLE, status: "OVERDUE", evidence: ev("OVERDUE"), evaluatedAt: "2026-06-13T00:00:00Z" },
  { id: "w-2", runId: "win-1", subjectId: "p-verified", measureId: "audiogram", evaluationPeriod: CYCLE, status: "COMPLIANT", evidence: ev("COMPLIANT"), evaluatedAt: "2026-06-13T00:00:00Z" },
];
const liveDeps = (): LiveCellDeps => ({
  outcomeStore: {
    listLatestPopulationRuns: latestRunsFromRows(WINNERS),
    listOutcomes: async (runId: string, opts?: { measureId?: string; subjectIds?: readonly string[] }) => {
      let rows = runId === "win-1" ? WIN_ROWS : [];
      if (opts?.measureId != null) rows = rows.filter((o) => o.measureId === opts.measureId);
      if (opts?.subjectIds !== undefined) {
        const wanted = new Set(opts.subjectIds);
        rows = rows.filter((o) => wanted.has(o.subjectId));
      }
      return rows;
    },
  },
} as unknown as LiveCellDeps);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  cases = new SqliteCaseStore(db);
  events = new SqliteCaseEventStore(db);
  runId = (await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  })).id;

  for (const subjectId of ["p-gap", "p-verified", "p-unknown", "p-open", "p-auto"]) {
    await cases.upsertFromOutcome({ runId, subjectId, measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  }
  const idOf = async (subjectId: string) => (await cases.listCases({ employeeId: subjectId, limit: 10 }))[0]!.id;
  // Three closures a PERSON made: a manual close (CQL still counts them), a rerun-verified close
  // (CQL agrees), and a manual close on a patient no winning run evaluated.
  await cases.patchCase(await idOf("p-gap"), { status: "CLOSED", closedAt: "2026-06-14T00:00:00Z", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.org" });
  await cases.patchCase(await idOf("p-verified"), {
    status: "RESOLVED", currentOutcomeStatus: "COMPLIANT", closedAt: "2026-06-14T00:00:00Z", closedReason: "RERUN_VERIFIED", closedBy: "cm@workwell.dev",
  });
  await cases.patchCase(await idOf("p-unknown"), { status: "CLOSED", closedAt: "2026-06-14T00:00:00Z", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.org" });
  // A SYSTEM closure, for contrast: COMPLIANT resolves the case and leaves closed_by NULL.
  await cases.upsertFromOutcome({ runId, subjectId: "p-auto", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "COMPLIANT" });
});

after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("worklistQueryFor — a BLANK token means what the CALLER says, and staff_closed asks the store who closed it", () => {
  // The three copies of this switch disagreed about a blank token, and folding them onto one function
  // with a hard-coded default would have silently shrunk the cases CSV from every case (32,558 on the
  // pilot) to the active ones (15,309). The parameter is the whole point of the fold.
  assert.deepEqual(worklistQueryFor("", { blank: "active" }), { statuses: [...ACTIVE_CASE_STATUSES] });
  assert.deepEqual(worklistQueryFor(null, { blank: "active" }), { statuses: [...ACTIVE_CASE_STATUSES] });
  assert.deepEqual(worklistQueryFor("", { blank: "all" }), {}, "the cases CSV applies no status filter by contract (§6.3)");
  assert.deepEqual(worklistQueryFor(undefined, { blank: "all" }), {});

  // `all` is the explicit unfiltered view on EVERY caller — the mutant that returns an array here
  // would silently filter the MCP tool's and the export's answers.
  for (const blank of ["active", "all"] as const) {
    assert.deepEqual(worklistQueryFor("all", { blank }), {}, "all → no predicate at all");
    assert.deepEqual(worklistQueryFor("open", { blank }), { statuses: [...ACTIVE_CASE_STATUSES] });
    assert.deepEqual(worklistQueryFor("closed", { blank }), { statuses: ["RESOLVED", "CLOSED"] });
    assert.deepEqual(worklistQueryFor("excluded", { blank }), { statuses: ["EXCLUDED"] });
    assert.deepEqual(worklistQueryFor("RESOLVED", { blank }), { statuses: ["RESOLVED"] }, "a literal status is still passed through");
  }

  const staff = worklistQueryFor(STAFF_CLOSED_TOKEN, { blank: "active" });
  assert.deepEqual(staff, { statuses: [...STAFF_CLOSED_STATUSES], closure: "staff" });
  assert.deepEqual([...STAFF_CLOSED_STATUSES], ["CLOSED", "RESOLVED", "EXCLUDED"], "every terminal status a person can write");
  assert.equal(staff.closure, "staff", "and WHO closed it is asked of the store, never filtered in JS");
});

test("closureKindOf — every closure a person made is STAFF, the run's is SYSTEM, an active case is NONE", () => {
  const kind = (status: string, closedBy: string | null) => closureKindOf({ status, closedBy });
  assert.equal(kind("OPEN", null), "NONE");
  assert.equal(kind("IN_PROGRESS", null), "NONE");
  // A person's name on an ACTIVE row would be a write-path bug, and the kind still reads NONE: the
  // row is workable, which is what every reader acts on.
  assert.equal(kind("OPEN", "nurse@example.org"), "NONE");
  assert.equal(kind("CLOSED", "nurse@example.org"), "STAFF", "a manual close");
  assert.equal(kind("RESOLVED", "cm@workwell.dev"), "STAFF", "a rerun-verified close is still a person's");
  assert.equal(kind("EXCLUDED", "cm@workwell.dev"), "STAFF", "so is a rerun-excluded one");
  assert.equal(kind("RESOLVED", null), "SYSTEM", "auto-resolved");
  assert.equal(kind("EXCLUDED", null), "SYSTEM", "excluded by the measure's logic");
});

test("the staff_closed list returns every closure a person made — and the open list is unchanged by it", async () => {
  const staffClosed = await loadWorklistCases(deps(), { status: STAFF_CLOSED_TOKEN });
  assert.deepEqual(
    staffClosed.map((c) => c.employeeId).sort(),
    ["p-gap", "p-unknown", "p-verified"],
    "the three a person closed — not the auto-resolved one, not the open one",
  );
  assert.ok(staffClosed.every((c) => c.closure === "STAFF"));
  assert.deepEqual(staffClosed.find((c) => c.employeeId === "p-gap")!.closedBy, "nurse@example.org");
  assert.equal(staffClosed.find((c) => c.employeeId === "p-gap")!.closedReason, "MANUAL_RESOLVE");

  // The open list is the ACTIVE set and nothing here changed it.
  const open = await loadWorklistCases(deps(), { status: "open" });
  assert.deepEqual(open.map((c) => c.employeeId), ["p-open"]);
  assert.ok(open.every((c) => c.closure === "NONE"));

  // The `closed` tab still lumps both kinds — that behaviour is deliberately untouched — but now says
  // which is which, so the tab can label them without a second query.
  const closed = await loadWorklistCases(deps(), { status: "closed", period: "all" });
  const kinds = new Set(closed.map((c) => c.closure));
  assert.deepEqual([...kinds].sort(), ["STAFF", "SYSTEM"], "both kinds are on the closed tab, each named");
});

test("the staff_closed list defaults to the CURRENT cycle, and period=all is the history", async () => {
  // A prior cycle's closure describes a prior cycle's gap; this cycle opened a new case. The default
  // must not show it, for the same reason the open list defaults to the current cycle.
  const prior = await cases.upsertFromOutcome({ runId, subjectId: "p-gap", measureId: "audiogram", evaluationPeriod: "2019-01-01", outcomeStatus: "OVERDUE" });
  await cases.patchCase(prior!.id, { status: "CLOSED", closedAt: "2019-02-01T00:00:00Z", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.org" });
  try {
    const current = await loadWorklistCases(deps(), { status: STAFF_CLOSED_TOKEN });
    assert.deepEqual(current.map((c) => c.evaluationPeriod).filter((p) => p !== CYCLE), [], "only this cycle");
    const history = await loadWorklistCases(deps(), { status: STAFF_CLOSED_TOKEN, period: "all" });
    assert.ok(history.some((c) => c.evaluationPeriod === "2019-01-01"), "asking for history gets it");
    assert.equal(history.length, current.length + 1);
  } finally {
    await cases.patchCase(prior!.id, { status: "OPEN", closedAt: null, closedReason: null, closedBy: null });
  }
});

test("withLiveStatus — the frozen status is replaced by what CQL says today, and UNKNOWN is its own answer", async () => {
  const staffClosed = await loadWorklistCases(deps(), { status: STAFF_CLOSED_TOKEN });
  const resolved = await withLiveStatus(liveDeps(), staffClosed);
  const of = (subjectId: string) => resolved.find((c) => c.employeeId === subjectId)!;

  // The patient a person closed while the run still counts them: the row's own frozen value happens
  // to agree here, but the LIVE fields are what the surface reads and they name their run.
  assert.equal(of("p-gap").liveState, "GAP");
  assert.equal(of("p-gap").liveOutcomeStatus, "OVERDUE");
  assert.equal(of("p-gap").liveOutcomeRunId, "win-1");

  // Rerun-verified: the frozen value says COMPLIANT and so does the run. CLEAR, so the surface says
  // "verified compliant by …" instead of "still counted by CQL" — the wording defect two reviewers
  // caught in the first draft of the plan.
  assert.equal(of("p-verified").liveState, "CLEAR");
  assert.equal(of("p-verified").liveOutcomeStatus, "COMPLIANT");

  // No winning run row for this patient: "not currently evaluable" is neither a gap nor cleared.
  assert.equal(of("p-unknown").liveState, "UNKNOWN");
  assert.equal(of("p-unknown").liveOutcomeStatus, null);
  assert.equal(of("p-unknown").currentOutcomeStatus, "OVERDUE", "the frozen value is still carried, under its own name");

  // A non-staff row is returned untouched — its `currentOutcomeStatus` IS live.
  const open = await withLiveStatus(liveDeps(), await loadWorklistCases(deps(), { status: "open" }));
  assert.equal(open[0]!.liveState, undefined, "no live fields on a row that cannot be stale");
  assert.equal(open[0]!.liveOutcomeStatus, undefined);

  // And a list with no staff closures asks the outcome store nothing at all.
  let called = 0;
  const counting = {
    outcomeStore: {
      listLatestPopulationRuns: async () => { called += 1; return []; },
      listOutcomes: async () => { called += 1; return []; },
    },
  } as unknown as LiveCellDeps;
  await withLiveStatus(counting, await loadWorklistCases(deps(), { status: "open" }));
  assert.equal(called, 0);
});

test("staffClosedCounts — the three numbers the tab header shows, and they sum to the list", async () => {
  const resolved = await withLiveStatus(liveDeps(), await loadWorklistCases(deps(), { status: STAFF_CLOSED_TOKEN }));
  const counts = staffClosedCounts(resolved);
  // Every term non-zero: an identity asserted over a fixture where two of three are zero passes for
  // any implementation (the lesson from #574's vacuous reconciliation test).
  assert.deepEqual(counts, { gap: 1, verified: 1, unknown: 1 });
  assert.equal(counts.gap + counts.verified + counts.unknown, resolved.length, "the three buckets partition the list");

  // UNKNOWN is the bucket an unresolved row falls into, never `verified` — a reader must not be told
  // a patient was verified when nothing evaluated them.
  const unresolved = staffClosedCounts(await loadWorklistCases(deps(), { status: STAFF_CLOSED_TOKEN }));
  assert.deepEqual(unresolved, { gap: 0, verified: 0, unknown: 3 }, "with no live pass, every row is UNKNOWN");
});

test("toCaseSummary — the closure fields ride on the summary, so a list can say who closed it", async () => {
  const row = (await cases.listCases({ employeeId: "p-gap", period: CYCLE, limit: 10 }))[0]! as CaseRecord;
  const summary = toCaseSummary(row, 0, lookup);
  assert.equal(summary.closure, "STAFF");
  assert.equal(summary.closedBy, "nurse@example.org");
  assert.equal(summary.closedReason, "MANUAL_RESOLVE");
  assert.equal(summary.closedAt, "2026-06-14T00:00:00Z");
  assert.equal(summary.liveState, undefined, "the live fields are added by withLiveStatus, not guessed here");
});

test("withLiveStatus — a closure from a PRIOR cycle is never labelled by today's run", async () => {
  // Reachable through `?period=all` and the history tabs. The winning run describes ITS OWN cycle, so
  // a gap somebody closed two years ago must not read as "verified compliant" because the patient
  // became compliant since. Without the period equality the row would take `p-gap`'s live OVERDUE —
  // or, worse for `p-verified`, a COMPLIANT that credits a person with a result from another year.
  const current = (await loadWorklistCases(deps(), { status: STAFF_CLOSED_TOKEN, period: "all" }))
    .filter((c) => c.employeeId === "p-gap" || c.employeeId === "p-verified");
  assert.equal(current.length, 2, "the fixture still has the two rows this test is about");

  // BY SUBJECT, never by position: the list's order is the store's, and two rows closed in the same
  // millisecond can come back either way round — an ordering this test has no opinion about.
  const stateBySubject = (rows: readonly CaseSummary[]) =>
    Object.fromEntries(rows.map((c) => [c.employeeId, c.liveState]));

  const resolvedCurrent = await withLiveStatus(liveDeps(), current);
  assert.deepEqual(stateBySubject(resolvedCurrent), { "p-gap": "GAP", "p-verified": "CLEAR" }, "in cycle, both are resolved");

  // The SAME rows, dated to a closed cycle. Nothing else changes.
  const stale = current.map((c) => ({ ...c, evaluationPeriod: "2024-01-01" }));
  const resolvedStale = await withLiveStatus(liveDeps(), stale);
  assert.deepEqual(stateBySubject(resolvedStale), { "p-gap": "UNKNOWN", "p-verified": "UNKNOWN" });
  assert.ok(resolvedStale.every((c) => c.liveOutcomeStatus === null));
  // The run id is still reported: the measure HAS a winning run, it simply describes another cycle,
  // and an empty run id would read as "no run at all".
  assert.ok(resolvedStale.every((c) => c.liveOutcomeRunId === "win-1"));
});
