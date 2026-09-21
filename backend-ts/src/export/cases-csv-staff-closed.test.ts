/**
 * The cases CSV's closure columns (#569) — `DATA_MODEL_CONTRACTS` §6.3.
 *
 * Why the export needs its own live columns rather than riding on `currentOutcomeStatus`: a case a
 * person closed is never touched by the nightly upsert again, so its `currentOutcomeStatus` is frozen
 * at the moment of closure. The CSV is the artifact people mail around and reconcile against, so a
 * row a person closed in March that CQL still counts in September has to say both things.
 *
 * The header is PINNED here, exactly, because the ACO's tooling reads these by name and an inserted
 * column surfaces downstream as wrong numbers rather than as an error.
 *
 * node --import tsx --test src/export/cases-csv-staff-closed.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaseQuery, CaseRecord, CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeRecord, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { LiveCellDeps } from "../compliance/live-cell.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";
import { casesCsv } from "./export-csv.ts";
import { liveFieldsFor } from "../compliance/live-cell.ts";
import { liveOrFrozenStatus, shownStatusFor } from "../case/worklist-read-model.ts";

const PERIOD = "2026-06-13";
const RUN = "win-1";

const caseRow = (over: Partial<CaseRecord> & { id: string; employeeId: string }): CaseRecord => ({
  measureId: "audiogram",
  evaluationPeriod: PERIOD,
  status: "CLOSED",
  priority: "HIGH",
  assignee: null,
  nextAction: null,
  nextActionSource: "OPERATOR",
  assignmentSource: null,
  currentOutcomeStatus: "OVERDUE",
  lastRunId: RUN,
  createdAt: "2026-06-13T00:00:00Z",
  updatedAt: "2026-06-13T00:00:00Z",
  closedAt: "2026-06-14T00:00:00Z",
  closedReason: "MANUAL_RESOLVE",
  closedBy: "nurse@example.org",
  ...over,
});

const CASES: CaseRecord[] = [
  // A person closed it and CQL still counts the patient — the row this whole change exists for.
  caseRow({ id: "case-gap", employeeId: "emp-006" }),
  // A person closed it by rerun-to-verify and CQL agrees.
  caseRow({ id: "case-verified", employeeId: "emp-007", status: "RESOLVED", closedReason: "RERUN_VERIFIED", closedBy: "cm@workwell.dev", currentOutcomeStatus: "COMPLIANT" }),
  // The RUN closed it: `closed_by` is NULL, so it is not a staff closure and gets no live columns.
  caseRow({ id: "case-auto", employeeId: "emp-008", status: "RESOLVED", closedReason: "AUTO_RESOLVED", closedBy: null }),
  // Still open: `currentOutcomeStatus` is already live for it, so the live columns stay empty.
  caseRow({ id: "case-open", employeeId: "emp-009", status: "OPEN", closedAt: null, closedReason: null, closedBy: null }),
];

const ev = (status: string) => ({ expressionResults: [{ define: "Outcome Status", result: status }] });
const WINNERS: OutcomeWithRun[] = [{
  runId: RUN, runStartedAt: "2026-06-13T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED",
  runTriggeredBy: "manual", subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE",
}];
const WIN_ROWS: OutcomeRecord[] = [
  { id: "w-1", runId: RUN, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: PERIOD, status: "OVERDUE", evidence: ev("OVERDUE"), evaluatedAt: "2026-06-13T00:00:00Z" },
  { id: "w-2", runId: RUN, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: PERIOD, status: "COMPLIANT", evidence: ev("COMPLIANT"), evaluatedAt: "2026-06-13T00:00:00Z" },
];

const liveDeps = (): LiveCellDeps => ({
  outcomeStore: {
    listLatestPopulationRuns: latestRunsFromRows(WINNERS),
    listOutcomes: async (runId: string, opts?: { measureId?: string; subjectIds?: readonly string[] }) => {
      let rows = runId === RUN ? WIN_ROWS : [];
      if (opts?.measureId != null) rows = rows.filter((o) => o.measureId === opts.measureId);
      if (opts?.subjectIds !== undefined) {
        const wanted = new Set(opts.subjectIds);
        rows = rows.filter((o) => wanted.has(o.subjectId));
      }
      return rows;
    },
  },
} as unknown as LiveCellDeps);

const caseStore = (onQuery?: (q: CaseQuery) => void) =>
  ({ listCases: async (q: CaseQuery) => { onQuery?.(q); return CASES; } }) as unknown as CaseStore;
const eventStore = () => ({ latestOutreachDeliveryStatuses: async () => ({}) }) as unknown as CaseEventStore;

/**
 * The header exactly as it stood before #569. Asserted by SLICE rather than by length, so a mutation
 * that renamed or reordered any of these fails — a length check would not.
 */
const PRE_569_HEADERS = [
  "caseId", "employeeExternalId", "employeeName", "role", "site", "measureName", "measureVersion", "evaluationPeriod",
  "status", "priority", "assignee", "currentOutcomeStatus", "nextAction", "lastRunId", "createdAt", "updatedAt",
  "closedAt", "latestOutreachDeliveryStatus", "providerId", "payer",
] as const;

const parse = (csv: string) => {
  const lines = csv.split("\r\n").filter(Boolean);
  const header = lines[0]!.split(",");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])) as Record<string, string>;
  });
  return { header, rows };
};

test("the cases CSV header carries the five closure columns, APPENDED (§6.3)", async () => {
  const csv = await casesCsv(caseStore(), eventStore(), {}, {}, liveDeps());
  const { header } = parse(csv);

  // Pinned exactly. Appended, never inserted: every column a consumer reading by position had before
  // is still at the same index, which is the rule §6.2's `notInPopulation` and §6.3's `providerId`
  // followed.
  assert.deepEqual(header.slice(0, PRE_569_HEADERS.length), PRE_569_HEADERS, "every pre-#569 column keeps its NAME and its INDEX");
  assert.deepEqual(header.slice(PRE_569_HEADERS.length), [
    "closedReason", "closedBy", "liveState", "liveOutcomeStatus", "liveOutcomeRunId",
  ]);
  assert.equal(header.indexOf("payer"), 19, "and the last pre-#569 column is still at 19");
});

test("the live columns are filled for the rows a PERSON closed, and empty for every other row", async () => {
  const queries: CaseQuery[] = [];
  const csv = await casesCsv(caseStore((q) => queries.push(q)), eventStore(), {}, {}, liveDeps());
  const { rows } = parse(csv);
  const byId = new Map(rows.map((r) => [r.caseId!, r]));

  const gap = byId.get("case-gap")!;
  assert.equal(gap.closedBy, "nurse@example.org");
  assert.equal(gap.closedReason, "MANUAL_RESOLVE");
  assert.equal(gap.liveState, "GAP", "the reconciliation column — the bucket alone cannot say this");
  assert.equal(gap.liveOutcomeStatus, "OVERDUE", "what the winning run says TODAY");
  assert.equal(gap.liveOutcomeRunId, RUN, "and which run said it, so the number can be traced");
  assert.equal(gap.currentOutcomeStatus, "OVERDUE", "the frozen value keeps its own column and its own meaning");

  const verified = byId.get("case-verified")!;
  assert.equal(verified.closedReason, "RERUN_VERIFIED");
  assert.equal(verified.liveState, "CLEAR");
  assert.equal(verified.liveOutcomeStatus, "COMPLIANT", "a rerun-verified closure CQL corroborates");

  // A SYSTEM closure and an OPEN case are not staff closures: their `currentOutcomeStatus` is either
  // live already or was written by the run that closed them, so the live columns stay EMPTY — and an
  // empty cell means "not a staff closure", which is why UNKNOWN is written as a word instead.
  const auto = byId.get("case-auto")!;
  assert.equal(auto.closedBy, "", "no person closed it");
  assert.equal(auto.liveState, "");
  assert.equal(auto.liveOutcomeStatus, "");
  assert.equal(auto.liveOutcomeRunId, "");
  const open = byId.get("case-open")!;
  assert.equal(open.closedAt, "");
  assert.equal(open.liveOutcomeStatus, "");

  // The live lookup asked about the two staff-closed subjects only — not the whole export, which on
  // the pilot is 32,558 rows.
  assert.equal(queries.length, 1, "one case read, as before");
});

test("a staff-closed row the winning run never evaluated says UNKNOWN, not an empty cell", async () => {
  // `emp-006` is in the run; point the export at a case for a subject the run never scored.
  const unevaluated = [caseRow({ id: "case-unknown", employeeId: "emp-010" })];
  const store = { listCases: async () => unevaluated } as unknown as CaseStore;
  const { rows } = parse(await casesCsv(store, eventStore(), {}, {}, liveDeps()));

  assert.equal(rows[0]!.liveState, "UNKNOWN");
  assert.equal(rows[0]!.liveOutcomeStatus, "UNKNOWN", "not evaluable is its own answer");
  assert.equal(rows[0]!.liveOutcomeRunId, RUN, "the measure HAS a winning run — this patient simply is not in it");
  assert.equal(rows[0]!.closedBy, "nurse@example.org", "and the closure is still reported");
});

test("without the live dependency the header is UNCHANGED and only the three live cells are empty", async () => {
  // The dependency is optional so every existing caller keeps working. The header must not change
  // shape depending on how the route was wired — a consumer's parser would break on the difference —
  // and the two closure columns are read off the case row, so they are filled either way.
  const csv = await casesCsv(caseStore(), eventStore(), {}, {});
  const { header, rows } = parse(csv);
  assert.deepEqual(header.slice(0, PRE_569_HEADERS.length), PRE_569_HEADERS);
  assert.equal(header.length, PRE_569_HEADERS.length + 5);
  assert.ok(rows.every((r) => r.liveState === "" && r.liveOutcomeStatus === "" && r.liveOutcomeRunId === ""));
  assert.equal(rows.find((r) => r.caseId === "case-gap")!.closedBy, "nurse@example.org", "the closure columns do not depend on it");
  assert.equal(rows.find((r) => r.caseId === "case-gap")!.closedReason, "MANUAL_RESOLVE");
});

test("a closure from a PRIOR cycle is never labelled by today's run", async () => {
  // This export applies NO period filter (§6.3 — every row, all history), so it carries more
  // prior-cycle closures than any other surface: on the pilot, every closure anyone has ever made.
  // The winning run describes ITS OWN cycle, so a 2024 gap somebody closed must not be exported as
  // "CLEAR / COMPLIANT" because the patient became compliant two years later — a reconciliation
  // column that answers about the wrong measurement year is worse than an absent one, since the
  // consumer has no way to see which year it describes.
  const priorCycle = [
    caseRow({ id: "case-prior-gap", employeeId: "emp-006", evaluationPeriod: "2024-01-01" }),
    caseRow({ id: "case-prior-verified", employeeId: "emp-007", evaluationPeriod: "2024-01-01", status: "RESOLVED", closedReason: "RERUN_VERIFIED", closedBy: "cm@workwell.dev", currentOutcomeStatus: "COMPLIANT" }),
  ];
  const store = { listCases: async () => priorCycle } as unknown as CaseStore;
  const { rows } = parse(await casesCsv(store, eventStore(), {}, {}, liveDeps()));
  const byId = new Map(rows.map((r) => [r.caseId!, r]));

  for (const id of ["case-prior-gap", "case-prior-verified"]) {
    const r = byId.get(id)!;
    assert.equal(r.liveState, "UNKNOWN", `${id}: the winner describes another cycle, so it says nothing about this row`);
    assert.equal(r.liveOutcomeStatus, "UNKNOWN");
    assert.equal(r.liveOutcomeRunId, RUN, "the measure HAS a winning run — it simply describes another year");
    assert.notEqual(r.closedBy, "", "the closure columns are read off the case row and do not depend on the cycle");
  }
  // The frozen value keeps its own column and its own meaning — it is what the last run that touched
  // the row wrote, which for these rows is what CQL said in 2024.
  assert.equal(byId.get("case-prior-gap")!.currentOutcomeStatus, "OVERDUE");
  assert.equal(byId.get("case-prior-verified")!.currentOutcomeStatus, "COMPLIANT");
});

/**
 * `?outcome` on the staff-closed list (2026-09-20).
 *
 * The work list resolves what CQL says TODAY for these rows and filters on THAT (`worklist-read-model`,
 * `liveOrFrozenStatus`), because `current_outcome_status` froze when the person closed the case. The
 * export took the same token from the same screen and handed it to the store, which compares the
 * frozen column — so the file both omitted a row the screen showed and carried one it did not, and
 * the carried row contradicted its own `liveOutcomeStatus` cell.
 *
 * The store stub below applies `q.outcome` the way the real stores do. That is what makes these
 * assertions real: if the export stops withholding the token, the stub filters on the frozen value
 * and the rows change.
 */
const FROZEN_OVERDUE_RUN = "win-2";
const MOVED: CaseRecord[] = [
  // A person closed it as OVERDUE; the winning run now says COMPLIANT.
  caseRow({ id: "case-moved", employeeId: "emp-006", currentOutcomeStatus: "OVERDUE", lastRunId: FROZEN_OVERDUE_RUN }),
  // A person closed it as OVERDUE and the winning run still says OVERDUE.
  caseRow({ id: "case-still", employeeId: "emp-007", currentOutcomeStatus: "OVERDUE", lastRunId: FROZEN_OVERDUE_RUN }),
];
const MOVED_WINNERS: OutcomeWithRun[] = [{
  runId: FROZEN_OVERDUE_RUN, runStartedAt: "2026-06-13T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED",
  runTriggeredBy: "manual", subjectId: "emp-006", measureId: "audiogram", status: "COMPLIANT",
}];
const MOVED_ROWS: OutcomeRecord[] = [
  { id: "m-1", runId: FROZEN_OVERDUE_RUN, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: PERIOD, status: "COMPLIANT", evidence: ev("COMPLIANT"), evaluatedAt: "2026-06-13T00:00:00Z" },
  { id: "m-2", runId: FROZEN_OVERDUE_RUN, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: PERIOD, status: "OVERDUE", evidence: ev("OVERDUE"), evaluatedAt: "2026-06-13T00:00:00Z" },
];

const movedLiveDeps = (rows: OutcomeRecord[] = MOVED_ROWS): LiveCellDeps => ({
  outcomeStore: {
    listLatestPopulationRuns: latestRunsFromRows(MOVED_WINNERS),
    listOutcomes: async (runId: string, opts?: { measureId?: string; subjectIds?: readonly string[] }) => {
      let out = runId === FROZEN_OVERDUE_RUN ? rows : [];
      if (opts?.measureId != null) out = out.filter((o) => o.measureId === opts.measureId);
      if (opts?.subjectIds !== undefined) {
        const wanted = new Set(opts.subjectIds);
        out = out.filter((o) => wanted.has(o.subjectId));
      }
      return out;
    },
  },
} as unknown as LiveCellDeps);

/** A store that applies `outcome` against the FROZEN column, exactly as both real stores do. */
const frozenFilteringStore = (all: CaseRecord[], onQuery?: (q: CaseQuery) => void) =>
  ({
    listCases: async (q: CaseQuery) => {
      onQuery?.(q);
      if (!q.outcome) return all;
      const want = q.outcome.toUpperCase();
      return all.filter((c) => (c.currentOutcomeStatus ?? "").toUpperCase() === want);
    },
  }) as unknown as CaseStore;

const idsOf = (csv: string) => parse(csv).rows.map((r) => r.caseId!).sort();

test("?outcome on the staff-closed export selects on what CQL says TODAY, as the screen does", async () => {
  const queries: CaseQuery[] = [];
  const store = () => frozenFilteringStore(MOVED, (q) => queries.push(q));

  // The screen shows `case-moved` as Compliant, so the CSV taken from it must contain that row and
  // only that row. Filtering on the frozen column would answer the exact opposite pair.
  assert.deepEqual(
    idsOf(await casesCsv(store(), eventStore(), { closure: "staff", outcome: "COMPLIANT" }, {}, movedLiveDeps())),
    ["case-moved"],
  );
  assert.deepEqual(
    idsOf(await casesCsv(store(), eventStore(), { closure: "staff", outcome: "OVERDUE" }, {}, movedLiveDeps())),
    ["case-still"],
  );
  // Lower-case, as `/api/cases` accepts it: both sides are folded, not just the caller's.
  assert.deepEqual(
    idsOf(await casesCsv(store(), eventStore(), { closure: "staff", outcome: "compliant" }, {}, movedLiveDeps())),
    ["case-moved"],
  );
  assert.ok(queries.length > 0 && queries.every((q) => q.outcome === undefined), "the token is withheld from the store on this list");
});

test("every other list keeps the SQL predicate on the frozen column", async () => {
  // For an active row the run refreshes `current_outcome_status`, and a system-closed row was closed
  // by the run that wrote it — so the frozen column IS live there and the fast path is correct. This
  // is the assertion that keeps the fix from quietly becoming "filter everything in memory".
  const queries: CaseQuery[] = [];
  const csv = await casesCsv(frozenFilteringStore(MOVED, (q) => queries.push(q)), eventStore(), { outcome: "OVERDUE" }, {}, movedLiveDeps());
  assert.equal(queries[0]?.outcome, "OVERDUE", "handed to the store, not applied in memory");
  assert.deepEqual(idsOf(csv), ["case-moved", "case-still"], "both rows are frozen OVERDUE");
});

/**
 * The filter reads the DISPLAY status; the COLUMN carries the canonical bucket. They are different
 * fields and the difference is load-bearing: an out-of-population row is canonical `MISSING_DATA`
 * and displays as out-of-population (ADR-079), so a filter comparing the canonical bucket would
 * select it under a heading saying Missing Data — a different claim about the patient than the one
 * the screen makes.
 *
 * Pinned on `liveFieldsFor` rather than through a fixture, because producing a cell whose display
 * state differs from its bucket needs an official-routed measure and its `official.populationResults`
 * evidence; a test that built one would be pinning `deriveCell`, which has its own. What matters
 * here is that the two fields stay distinct and keep their sources, since the export filter reads one
 * and the CSV column the other.
 */
test("liveFieldsFor keeps the display status and the canonical bucket apart", () => {
  const fields = liveFieldsFor({
    state: "CLEAR",
    runId: "run-9",
    cell: { status: "OUT_OF_POPULATION", method: "m", canonical: "MISSING_DATA", evaluationPeriod: PERIOD },
  });
  assert.equal(fields.displayStatus, "OUT_OF_POPULATION", "what a surface SHOWS, and what the outcome filter compares");
  assert.equal(fields.outcomeStatus, "MISSING_DATA", "the canonical bucket, which is the CSV's liveOutcomeStatus column");
  assert.equal(fields.state, "CLEAR");
  assert.equal(fields.runId, "run-9");

  // No cell (no winning run, or a winner describing another cycle) leaves BOTH null, which is how a
  // reader falls back to the frozen column instead of reading an absence as an answer.
  const none = liveFieldsFor({ state: "CLEAR", runId: "run-9", cell: null });
  assert.equal(none.displayStatus, null);
  assert.equal(none.outcomeStatus, null);
  assert.equal(none.state, "UNKNOWN", "and the state says so");
  assert.equal(none.runId, "run-9", "the run is still named, so the absence can be traced");
});

/**
 * The adapter the cases CSV filters through, and the assertion that kills the one mutant the
 * fixtures could not: swapping the display status for the canonical bucket here changes which rows
 * the export selects, so it has to fail something.
 */
test("shownStatusFor takes the DISPLAY status from a liveFieldsFor result, never the bucket", () => {
  const fields = liveFieldsFor({
    state: "CLEAR",
    runId: "run-9",
    cell: { status: "OUT_OF_POPULATION", method: "m", canonical: "MISSING_DATA", evaluationPeriod: PERIOD },
  });
  assert.equal(shownStatusFor("OVERDUE", fields), "OUT_OF_POPULATION", "the word the screen shows");
  assert.notEqual(shownStatusFor("OVERDUE", fields), "MISSING_DATA", "and not the bucket the CSV column carries");
  // No live answer at all ⇒ the frozen column, which is what every non-staff-closed row gets.
  assert.equal(shownStatusFor("OVERDUE", null), "OVERDUE");
  assert.equal(shownStatusFor("OVERDUE", liveFieldsFor({ state: "CLEAR", runId: null, cell: null })), "OVERDUE");
});

// The work list's own rule, applied to the same three fields — the function BOTH surfaces filter on.
test("liveOrFrozenStatus prefers the display status, then the bucket, then the frozen column", () => {
  const frozen = { currentOutcomeStatus: "OVERDUE" };
  assert.equal(liveOrFrozenStatus({ ...frozen, liveDisplayStatus: "OUT_OF_POPULATION", liveOutcomeStatus: "MISSING_DATA" }), "OUT_OF_POPULATION");
  assert.equal(liveOrFrozenStatus({ ...frozen, liveDisplayStatus: null, liveOutcomeStatus: "COMPLIANT" }), "COMPLIANT");
  assert.equal(liveOrFrozenStatus({ ...frozen, liveDisplayStatus: null, liveOutcomeStatus: null }), "OVERDUE", "no live answer ⇒ the frozen column");
  assert.equal(liveOrFrozenStatus(frozen), "OVERDUE", "and absent fields behave as null, not as empty");
});
