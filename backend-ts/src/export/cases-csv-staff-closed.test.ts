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
