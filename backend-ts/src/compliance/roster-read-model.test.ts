import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun, OutcomeRecord } from "../stores/outcome-store.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { PANELS } from "./panels.ts";
import { buildRoster } from "./roster-read-model.ts";

const EMP = EMPLOYEES[0]!.externalId; // a real directory subject (emp-001, role "Author", site "HQ")
const EMP_ROLE = EMPLOYEES[0]!.role;

/** A segment whose cohort matches the first directory subject by role. */
function segmentFor(measureIds: string[], opts: { enabled?: boolean } = {}): HydratedSegment {
  return {
    id: "seg-1",
    name: "Segment One",
    description: "",
    enabled: opts.enabled ?? true,
    rule: { match: "ANY", conditions: [{ attr: "role", op: "equals", value: EMP_ROLE }] },
    measureIds,
    overrides: [],
    createdBy: "test",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

function fakeStore(withRun: OutcomeWithRun[], byRun: Record<string, OutcomeRecord[]>): OutcomeStore {
  return {
    listOutcomesWithRun: async () => withRun,
    listOutcomes: async (runId: string) => byRun[runId] ?? [],
    recordOutcome: async () => { throw new Error("unused"); },
    recordOutcomes: async () => { throw new Error("unused"); },
    listOutcomesForMeasure: async () => { throw new Error("unused"); },
    listOutcomesForEmployee: async () => { throw new Error("unused"); },
    getOutcomeById: async () => { throw new Error("unused"); },
    aggregateScaleRun: async () => [],
    countOutcomesByStatus: async () => [],
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
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun), segments: [] }, { panel: "immunizations" });

  assert.equal(roster.panel, "immunizations");
  assert.ok(roster.columns.some((c) => c.measureId === "mmr" && c.complianceClass === "PERMANENT"));
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
  assert.equal(row.cells["mmr"]!.method, "2 valid dose(s)");
  assert.equal(row.cells["flu_vaccine"]!.status, "NA");
  assert.equal(roster.total, EMPLOYEES.length);
});

test("buildRoster — status filter keeps only subjects with >=1 matching cell; page-size bounds rows", async () => {
  const roster = await buildRoster({ outcomeStore: fakeStore([], {}), segments: [] }, { panel: "osha", status: "COMPLIANT", pageSize: 10 });
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
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun), segments: [] }, { panel: "immunizations" });
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

  const roster = await buildRoster({ outcomeStore: store, segments: [] }, { panel: "immunizations" });
  assert.equal(calls, 1, "one shared run → listOutcomes called exactly once (run-cache)");
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
  assert.equal(row.cells["varicella"]!.status, "COMPLIANT");
  assert.equal(row.cells["adult_immunization"]!.status, "NA");
  assert.equal(row.cells["adult_immunization"]!.method, "Not evaluated");
});

// — E13 multi-tenant filter —

test("buildRoster — tenant filter scopes rows; rows carry tenantId/tenantName", async () => {
  const all = await buildRoster({ outcomeStore: fakeStore([], {}), segments: [] }, { panel: "osha", pageSize: 200 });
  // the full directory spans both tenants
  assert.ok(all.rows.some((r) => r.subject.tenantId === "twh"));
  assert.ok(all.rows.some((r) => r.subject.tenantId === "ihn"));

  const twh = await buildRoster({ outcomeStore: fakeStore([], {}), segments: [] }, { panel: "osha", tenant: "twh", pageSize: 200 });
  assert.ok(twh.rows.length > 0);
  assert.ok(twh.rows.every((r) => r.subject.tenantId === "twh"), "tenant filter scopes rows to twh");
  assert.equal(twh.rows[0]!.subject.tenantName, "Total Worker Health");
  assert.ok(twh.total < all.total, "twh-only total is smaller than the all-tenant total");

  const ihn = await buildRoster({ outcomeStore: fakeStore([], {}), segments: [] }, { panel: "osha", tenant: "ihn", pageSize: 200 });
  assert.equal(twh.total + ihn.total, all.total, "twh + ihn partitions the full directory");
});

// — E11.3 segment applicability overlay + filter —

const mmrSeed = (): { withRun: OutcomeWithRun[]; byRun: Record<string, OutcomeRecord[]> } => ({
  withRun: [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "COMPLIANT" },
  ],
  byRun: {
    "run-1": [
      { id: "o-1", runId: "run-1", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
    ],
  },
});

test("buildRoster — overlay: an ENABLED segment matching the subject but excluding the measure ⇒ NOT_APPLICABLE", async () => {
  const { withRun, byRun } = mmrSeed();
  // Segment matches EMP (by role) but its rule-set does NOT include "mmr" → the COMPLIANT cell is overridden.
  const segment = segmentFor(["varicella"]);
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun), segments: [segment] }, { panel: "immunizations" });
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "NOT_APPLICABLE", "out-of-cohort overlay wins over the real outcome");
  assert.equal(row.cells["mmr"]!.method, "Not applicable (no matching group)");
  assert.equal(row.cells["mmr"]!.evidenceRef, undefined, "a NOT_APPLICABLE cell carries no evidenceRef");
  // varicella IS in the rule-set → applicable; with no outcome it falls back to NA, not NOT_APPLICABLE.
  assert.equal(row.cells["varicella"]!.status, "NA");
});

test("buildRoster — reversibility: zero enabled segments ⇒ the real COMPLIANT status stands (no overlay)", async () => {
  const { withRun, byRun } = mmrSeed();
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun), segments: [] }, { panel: "immunizations" });
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
  assert.equal(row.cells["mmr"]!.evidenceRef?.runId, "run-1");
});

test("buildRoster — segment filter scopes columns to the rule-set and rows to the cohort", async () => {
  const { withRun, byRun } = mmrSeed();
  const segment = segmentFor(["mmr", "varicella"]);
  const roster = await buildRoster(
    { outcomeStore: fakeStore(withRun, byRun), segments: [segment] },
    { panel: "immunizations", segment: "seg-1" },
  );
  // columns = the segment's rule-set intersected with Active runnable measures (mmr + varicella are Active).
  assert.deepEqual(roster.columns.map((c) => c.measureId).sort(), ["mmr", "varicella"]);
  // every returned row's subject matches the segment cohort (role === EMP_ROLE).
  assert.ok(roster.rows.length > 0);
  for (const r of roster.rows) {
    const e = EMPLOYEES.find((x) => x.externalId === r.subject.externalId)!;
    assert.equal(e.role, EMP_ROLE, `row ${r.subject.externalId} must be in the cohort`);
  }
  // EMP is in cohort and its mmr is in-rule-set → keeps its real COMPLIANT status.
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
});

test("buildRoster — filtering by a DISABLED segment falls back to the panel (segment not in effect)", async () => {
  const { withRun, byRun } = mmrSeed();
  const segment = segmentFor(["mmr", "varicella"], { enabled: false });
  const roster = await buildRoster(
    { outcomeStore: fakeStore(withRun, byRun), segments: [segment] },
    { panel: "immunizations", segment: "seg-1" },
  );
  // Columns are the full panel (a disabled segment does not scope them), not the segment's 2-measure rule-set.
  assert.deepEqual(roster.columns.map((c) => c.measureId).sort(), PANELS.immunizations.slice().sort());
  // With no ENABLED segment the overlay is inert — EMP's mmr keeps its real COMPLIANT status.
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
});
