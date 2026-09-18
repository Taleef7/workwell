/**
 * The roster's staff-closure overlay (#569) — the highest-value half of the change, because every
 * programs chip drills into this grid.
 *
 * What it must hold: the marker appears only where a PERSON closed the case, in THIS cycle, while the
 * winning run still counts the patient as a gap; `cell.status` is untouched, so every chip count and
 * the `?status=` filter reproduce exactly; and the cached cell object — frozen and shared by
 * reference across requests — is replaced by a copy rather than mutated.
 *
 * node --import tsx --test src/compliance/roster-staff-closure.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeRecord, OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { CaseQuery, CaseRecord, CaseStore } from "../stores/case-store.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";
import { EMPLOYEES, isDemoPersona } from "../engine/synthetic/employee-catalog.ts";
import { buildRoster, type RosterCellCache } from "./roster-read-model.ts";

const REAL = EMPLOYEES.filter((e) => !isDemoPersona(e.externalId));
const PERIOD = "2026-06-13";
const ev = (results: Array<[string, unknown]>) => ({ expressionResults: results.map(([define, result]) => ({ define, result })) });

function fakeOutcomeStore(withRun: OutcomeWithRun[], byRun: Record<string, OutcomeRecord[]>): OutcomeStore {
  return {
    listOutcomesWithRun: async () => withRun,
    listLatestPopulationRuns: latestRunsFromRows(withRun),
    listOutcomes: async (runId: string) => byRun[runId] ?? [],
    listLatestPopulationOutcomes: async () => { throw new Error("unused"); },
    compactOlderThan: async () => 0,
    listLatestFinalizedOutcomePerMeasure: async () => { throw new Error("unused"); },
    hasOutcomes: async () => { throw new Error("unused"); },
    recordOutcome: async () => { throw new Error("unused"); },
    recordOutcomes: async () => { throw new Error("unused"); },
    listOutcomesForMeasure: async () => { throw new Error("unused"); },
    listOutcomesForEmployee: async () => { throw new Error("unused"); },
    getOutcomeById: async () => { throw new Error("unused"); },
    distinctMeasuresForRun: async () => { throw new Error("unused"); },
    aggregateScaleRun: async () => [],
    countOutcomesByStatus: async () => [],
  } as unknown as OutcomeStore;
}

/** One case row, defaulting to a STAFF closure (a person's name in `closed_by`) in the cell's cycle. */
function caseRow(over: Partial<CaseRecord> & { employeeId: string; measureId: string }): CaseRecord {
  return {
    id: `case-${over.employeeId}-${over.measureId}`,
    evaluationPeriod: PERIOD,
    status: "CLOSED",
    priority: "HIGH",
    assignee: null,
    nextAction: null,
    nextActionSource: "OPERATOR",
    assignmentSource: null,
    currentOutcomeStatus: "OVERDUE",
    lastRunId: "run-1",
    createdAt: "2026-06-13T00:00:00Z",
    updatedAt: "2026-06-13T00:00:00Z",
    closedAt: "2026-06-14T00:00:00Z",
    closedReason: "MANUAL_RESOLVE",
    closedBy: "nurse@example.org",
    ...over,
  };
}

/**
 * A case store that serves `rows` and records the query. It HONOURS `closure` and `employeeIds`, so a
 * read model that forgot either predicate cannot be saved by a permissive fake — which is how the
 * open rows leaked into the first draft of the store predicate.
 */
function fakeCaseStore(rows: CaseRecord[]) {
  const queries: CaseQuery[] = [];
  const store = {
    listCases: async (query: CaseQuery) => {
      queries.push(query);
      let out = rows;
      if (query.closure) {
        out = out.filter((c) => {
          const terminal = !["OPEN", "IN_PROGRESS"].includes(c.status);
          return terminal && (query.closure === "staff" ? c.closedBy != null : c.closedBy == null);
        });
      }
      if (query.employeeIds !== undefined) {
        const wanted = new Set(query.employeeIds);
        out = out.filter((c) => wanted.has(c.employeeId));
      }
      return out;
    },
  };
  return { store: store as unknown as Pick<CaseStore, "listCases">, queries };
}

const overdueRow = (subjectId: string): OutcomeWithRun => ({
  runId: "run-1", runStartedAt: "2026-06-13T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED",
  runTriggeredBy: "manual", subjectId, measureId: "mmr", status: "OVERDUE",
});
const outcomeRow = (subjectId: string, status: string, id: string): OutcomeRecord => ({
  id, runId: "run-1", subjectId, measureId: "mmr", evaluationPeriod: PERIOD, status,
  evidence: status === "COMPLIANT" ? ev([["Dose Count", 2]]) : ev([["Outcome Status", status]]),
  evaluatedAt: "2026-06-13T00:00:00Z",
});

test("buildRoster — a case a PERSON closed is marked on the cell, and only while CQL still counts the patient (#569)", async () => {
  const gap = REAL[0]!.externalId;
  const verified = REAL[1]!.externalId;
  const systemClosed = REAL[2]!.externalId;
  const priorCycle = REAL[3]!.externalId;

  const withRun = [gap, verified, systemClosed, priorCycle].map(overdueRow);
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      outcomeRow(gap, "OVERDUE", "o-1"),
      // Rerun-verified: a person closed it AND the run agrees. No marker — "still counted by CQL"
      // would be false, which is the wording defect this condition exists to prevent.
      outcomeRow(verified, "COMPLIANT", "o-2"),
      outcomeRow(systemClosed, "OVERDUE", "o-3"),
      outcomeRow(priorCycle, "OVERDUE", "o-4"),
    ],
  };
  const cases = fakeCaseStore([
    caseRow({ employeeId: gap, measureId: "mmr" }),
    caseRow({ employeeId: verified, measureId: "mmr", status: "RESOLVED", closedReason: "RERUN_VERIFIED", closedBy: "cm@workwell.dev", currentOutcomeStatus: "COMPLIANT" }),
    // A SYSTEM closure — the run closed it; nobody decided anything.
    caseRow({ employeeId: systemClosed, measureId: "mmr", status: "RESOLVED", closedReason: "AUTO_RESOLVED", closedBy: null }),
    // A person's closure from a PRIOR cycle. It describes a prior cycle's gap, and this cycle opened
    // a new case; marking today's cell from it would credit a decision nobody made about today.
    caseRow({ employeeId: priorCycle, measureId: "mmr", evaluationPeriod: "2025-06-13" }),
  ]);

  const cache: RosterCellCache = new Map();
  const roster = await buildRoster(
    { outcomeStore: fakeOutcomeStore(withRun, byRun), caseStore: cases.store, segments: [], cellCache: cache },
    { panel: "immunizations", pageSize: 100000 },
  );
  const cellFor = (subjectId: string) => roster.rows.find((r) => r.subject.externalId === subjectId)!.cells["mmr"]!;

  // "The status is unchanged" is asserted against the roster the pre-#569 code would have built —
  // the same inputs with no case store — rather than against a hard-coded display state. That is the
  // claim that matters (every chip count and the ?status= filter reproduce exactly) and it cannot
  // drift with the display vocabulary.
  const baseline = await buildRoster({ outcomeStore: fakeOutcomeStore(withRun, byRun), segments: [] }, { panel: "immunizations", pageSize: 100000 });
  for (const row of baseline.rows) {
    const before = row.cells["mmr"]!;
    const after = roster.rows.find((r) => r.subject.externalId === row.subject.externalId)!.cells["mmr"]!;
    const { staffClosure, ...rest } = after;
    assert.deepEqual(rest, before, `every field but the marker is identical for ${row.subject.externalId}`);
    assert.ok(staffClosure === undefined || row.subject.externalId === gap, "and only the one gap row gained a marker");
  }

  const marked = cellFor(gap);
  assert.equal(marked.status, baseline.rows.find((r) => r.subject.externalId === gap)!.cells["mmr"]!.status, "the CQL status is UNCHANGED");
  assert.equal(marked.canonical, "OVERDUE", "and the canonical bucket the gap test read is the run's own");
  assert.deepEqual(marked.staffClosure, { closedBy: "nurse@example.org", closedAt: "2026-06-14T00:00:00Z", closedReason: "MANUAL_RESOLVE" });
  assert.equal(cellFor(verified).staffClosure, undefined, "a rerun-VERIFIED closure sits on a compliant cell and gets no marker");
  assert.equal(cellFor(systemClosed).staffClosure, undefined, "a SYSTEM closure is not somebody's decision");
  assert.equal(cellFor(priorCycle).staffClosure, undefined, "a prior cycle's closure does not mark this cycle's cell");

  // ONE bounded read, scoped to the page's subjects, asking the STORE for the classification.
  assert.equal(cases.queries.length, 1);
  assert.equal(cases.queries[0]!.closure, "staff");
  assert.ok(cases.queries[0]!.employeeIds, "scoped to the page's subjects, not the whole practice");

  // The cached cell is shared by reference across requests and frozen, so the overlay must replace
  // the row's cell with a COPY. A mutation would surface here as a marked cached cell (or a throw).
  const cached = cache.get("mmr")!.cells.get(gap)!;
  assert.equal(cached.staffClosure, undefined, "the cache entry is untouched");
  assert.notEqual(cached, marked, "the row carries a copy, not the cached object");
  assert.ok(Object.isFrozen(cached), "and the cached cell is still frozen");
});

test("buildRoster — the overlay is off without a case store, and silent when nothing is staff-closed", async () => {
  const subjectId = REAL[0]!.externalId;
  const withRun = [overdueRow(subjectId)];
  const byRun: Record<string, OutcomeRecord[]> = { "run-1": [outcomeRow(subjectId, "OVERDUE", "o-1")] };
  const cellOf = (roster: Awaited<ReturnType<typeof buildRoster>>) =>
    roster.rows.find((r) => r.subject.externalId === subjectId)!.cells["mmr"]!;

  // Omitted store: the pre-#569 behaviour exactly, which is what keeps every existing test valid.
  const without = await buildRoster({ outcomeStore: fakeOutcomeStore(withRun, byRun), segments: [] }, { panel: "immunizations", pageSize: 100000 });
  assert.equal(cellOf(without).staffClosure, undefined);

  // Present store, nothing closed: one read, no marker, no error.
  const empty = fakeCaseStore([]);
  const present = await buildRoster(
    { outcomeStore: fakeOutcomeStore(withRun, byRun), caseStore: empty.store, segments: [] },
    { panel: "immunizations", pageSize: 100000 },
  );
  assert.equal(cellOf(present).staffClosure, undefined);
  assert.equal(empty.queries.length, 1);
});

test("buildRoster — the overlay reads only the PAGE's subjects, and a closure on another measure's column is ignored", async () => {
  const onPage = REAL[0]!.externalId;
  const offPage = REAL[1]!.externalId;
  const withRun = [overdueRow(onPage), overdueRow(offPage)];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [outcomeRow(onPage, "OVERDUE", "o-1"), outcomeRow(offPage, "OVERDUE", "o-2")],
  };
  const cases = fakeCaseStore([
    caseRow({ employeeId: onPage, measureId: "mmr" }),
    caseRow({ employeeId: offPage, measureId: "mmr" }),
    // A closure on a measure that is NOT a column of this panel: there is no cell to mark, and the
    // overlay must not throw or attach it to the wrong column.
    caseRow({ employeeId: onPage, measureId: "audiogram" }),
  ]);

  // pageSize 1 with the roster's ordering puts exactly one row on the page.
  const roster = await buildRoster(
    { outcomeStore: fakeOutcomeStore(withRun, byRun), caseStore: cases.store, segments: [] },
    { panel: "immunizations", page: 1, pageSize: 1 },
  );
  assert.equal(roster.rows.length, 1);
  assert.equal(roster.total, EMPLOYEES.length, "the total still counts every filtered row, not the page");
  const ids = cases.queries[0]!.employeeIds!;
  assert.equal(ids.length, 1, "one subject on the page → one subject in the bind");
  assert.equal(ids[0], roster.rows[0]!.subject.externalId);
  assert.ok(roster.rows[0]!.cells["mmr"]!.staffClosure, "and that row is marked");
  assert.equal(roster.rows[0]!.cells["audiogram"], undefined, "audiogram is not a column of this panel");
});
