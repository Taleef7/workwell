import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun, OutcomeRecord } from "../stores/outcome-store.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { buildRoster } from "./roster-read-model.ts";

const EMP = EMPLOYEES[0]!.externalId; // a real directory subject

function fakeStore(withRun: OutcomeWithRun[], byRun: Record<string, OutcomeRecord[]>): OutcomeStore {
  return {
    listOutcomesWithRun: async () => withRun,
    listOutcomes: async (runId: string) => byRun[runId] ?? [],
    recordOutcome: async () => { throw new Error("unused"); },
    recordOutcomes: async () => { throw new Error("unused"); },
    listOutcomesForMeasure: async () => { throw new Error("unused"); },
    listOutcomesForEmployee: async () => { throw new Error("unused"); },
    getOutcomeById: async () => { throw new Error("unused"); },
  } as OutcomeStore;
}

const ev = (results: Array<[string, unknown]>) => ({ expressionResults: results.map(([define, result]) => ({ define, result })) });

test("buildRoster — columns reflect the panel; a COMPLIANT mmr cell carries the dose method", async () => {
  const withRun: OutcomeWithRun[] = [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "COMPLIANT" },
  ];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      { id: "o-1", runId: "run-1", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
    ],
  };
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun) }, { panel: "immunizations" });

  assert.equal(roster.panel, "immunizations");
  assert.ok(roster.columns.some((c) => c.measureId === "mmr" && c.complianceClass === "PERMANENT"));
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
  assert.equal(row.cells["mmr"]!.method, "2 valid dose(s)");
  assert.equal(row.cells["flu_vaccine"]!.status, "NA");
  assert.equal(roster.total, EMPLOYEES.length);
});

test("buildRoster — status filter keeps only subjects with >=1 matching cell; page-size bounds rows", async () => {
  const roster = await buildRoster({ outcomeStore: fakeStore([], {}) }, { panel: "osha", status: "COMPLIANT", pageSize: 10 });
  assert.equal(roster.rows.length, 0);
  assert.equal(roster.total, 0);
});

test("buildRoster — a newer in-flight RUNNING run is ignored; the last COMPLETED roster stands", async () => {
  // run-2 is newer but still RUNNING (an async ALL_PROGRAMS run persists outcomes before finalizing),
  // carrying a partial OVERDUE outcome. The roster must keep run-1's COMPLETED COMPLIANT cell.
  const withRun: OutcomeWithRun[] = [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "COMPLIANT" },
    { runId: "run-2", runStartedAt: "2026-06-19T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "RUNNING", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "OVERDUE" },
  ];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      { id: "o-1", runId: "run-1", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
    ],
    "run-2": [
      { id: "o-2", runId: "run-2", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-19", status: "OVERDUE", evidence: ev([["Dose Count", 0]]), evaluatedAt: "2026-06-19T00:00:00Z" },
    ],
  };
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun) }, { panel: "immunizations" });
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT", "in-flight RUNNING run must not override the last COMPLETED cell");
  assert.equal(row.cells["mmr"]!.evidenceRef?.runId, "run-1");
});

test("buildRoster — two panel measures sharing one run load it once (no N+1); unevaluated measure → NA method", async () => {
  const withRun: OutcomeWithRun[] = [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "COMPLIANT" },
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "varicella", status: "COMPLIANT" },
  ];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      { id: "o-1", runId: "run-1", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
      { id: "o-2", runId: "run-1", subjectId: EMP, measureId: "varicella", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
    ],
  };
  const store = fakeStore(withRun, byRun);
  let calls = 0;
  const orig = store.listOutcomes.bind(store);
  store.listOutcomes = async (id: string) => { calls++; return orig(id); };

  const roster = await buildRoster({ outcomeStore: store }, { panel: "immunizations" });
  assert.equal(calls, 1, "one shared run → listOutcomes called exactly once (run-cache)");
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
  assert.equal(row.cells["varicella"]!.status, "COMPLIANT");
  assert.equal(row.cells["adult_immunization"]!.status, "NA");
  assert.equal(row.cells["adult_immunization"]!.method, "Not evaluated");
});
