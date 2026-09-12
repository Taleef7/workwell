import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun, OutcomeRecord } from "../stores/outcome-store.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";
import { EMPLOYEES, isDemoPersona } from "../engine/synthetic/employee-catalog.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { PANELS } from "./panels.ts";
import { buildRoster, type RosterCellCache } from "./roster-read-model.ts";
import { replaceLiveDirectory } from "../engine/ingress/webchart/live-directory.ts";

// The first REAL (non-demo) directory subject. emp-001..004 are demo-login personas that now sink to the
// bottom of the roster regardless of data (UX-1), so they'd fall off page 1 — use a real employee here.
const FIRST_REAL = EMPLOYEES.find((e) => !isDemoPersona(e.externalId))!;
const EMP = FIRST_REAL.externalId;
const EMP_ROLE = FIRST_REAL.role;

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
    listLatestPopulationOutcomes: async () => { throw new Error("unused: the roster resolves winners via listLatestPopulationRuns"); },
    listLatestPopulationRuns: latestRunsFromRows(withRun),
    listOutcomes: async (runId: string) => byRun[runId] ?? [],
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
  assert.deepEqual(roster.availablePanels, ["immunizations", "osha", "wellness"]);
  assert.ok(roster.columns.some((c) => c.measureId === "mmr" && c.complianceClass === "PERMANENT"));
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
  assert.equal(row.cells["mmr"]!.method, "2 valid dose(s)");
  assert.equal(row.cells["flu_vaccine"]!.status, "NA");
  assert.equal(roster.total, EMPLOYEES.length);
});

test("buildRoster — restart rehydrates completed wc rows with raw ids, then registry refresh restores names", async () => {
  replaceLiveDirectory([]);
  try {
    const subjectId = "wc|restart-patient-1";
    const failedSubjectId = "wc|failed-patient";
    const withRun: OutcomeWithRun[] = [
      { runId: "run-wc-ok", runStartedAt: "2026-07-17T00:00:00Z", runScopeType: "MEASURE", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId, measureId: "mmr", status: "COMPLIANT" },
      { runId: "run-wc-failed", runStartedAt: "2026-07-18T00:00:00Z", runScopeType: "MEASURE", runStatus: "FAILED", runTriggeredBy: "manual", subjectId: failedSubjectId, measureId: "mmr", status: "OVERDUE" },
    ];
    const byRun: Record<string, OutcomeRecord[]> = {
      "run-wc-ok": [
        { id: "out-wc-ok", runId: "run-wc-ok", subjectId, measureId: "mmr", evaluationPeriod: "2026-07-17", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-07-17T00:00:00Z" },
      ],
    };

    const restarted = await buildRoster(
      { outcomeStore: fakeStore(withRun, byRun), segments: [], webChartEnv: { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" } },
      { panel: "immunizations", tenant: "wc", pageSize: 200 },
    );
    assert.equal(restarted.total, 1);
    assert.equal(restarted.rows[0]!.subject.externalId, subjectId);
    assert.equal(restarted.rows[0]!.subject.name, "restart-patient-1");
    assert.equal(restarted.rows[0]!.subject.site, "WebChart");
    assert.equal(restarted.rows[0]!.subject.tenantName, "WebChart (webchart.test)");
    assert.equal(restarted.rows[0]!.cells.mmr!.status, "COMPLIANT");
    assert.equal(restarted.rows.some((row) => row.subject.externalId === failedSubjectId), false, "FAILED population rows stay invisible");

    replaceLiveDirectory([{ resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id: "restart-patient-1", name: [{ given: ["Amina"], family: "Khan" }] } }] }]);
    const refreshed = await buildRoster(
      { outcomeStore: fakeStore(withRun, byRun), segments: [], webChartEnv: { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" } },
      { panel: "immunizations", tenant: "wc", pageSize: 200 },
    );
    assert.equal(refreshed.rows[0]!.subject.name, "Amina Khan");
  } finally {
    replaceLiveDirectory([]);
  }
});

test("buildRoster — caches derived cells per measure's latest run; a newer run supersedes (perf #233)", async () => {
  let loadCount = 0;
  const counting = (withRun: OutcomeWithRun[], byRun: Record<string, OutcomeRecord[]>): OutcomeStore => ({
    ...fakeStore(withRun, byRun),
    listOutcomes: async (runId: string) => { loadCount++; return byRun[runId] ?? []; },
  }) as OutcomeStore;
  const cache: RosterCellCache = new Map();

  const withRunV1: OutcomeWithRun[] = [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "COMPLIANT" },
  ];
  const byRunV1: Record<string, OutcomeRecord[]> = {
    "run-1": [{ id: "o-1", runId: "run-1", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" }],
  };

  const first = await buildRoster({ outcomeStore: counting(withRunV1, byRunV1), segments: [], cellCache: cache }, { panel: "immunizations" });
  assert.equal(loadCount, 1, "first build loads the run's outcomes");
  assert.equal(first.rows.find((r) => r.subject.externalId === EMP)!.cells["mmr"]!.method, "2 valid dose(s)");

  // Same latest run + same cache → served from cache, no reload.
  const second = await buildRoster({ outcomeStore: counting(withRunV1, byRunV1), segments: [], cellCache: cache }, { panel: "immunizations" });
  assert.equal(loadCount, 1, "cache hit for the same latest run — no second load");
  assert.equal(second.rows.find((r) => r.subject.externalId === EMP)!.cells["mmr"]!.status, "COMPLIANT");

  // A newer run for mmr supersedes the cached entry → recompute with the new evidence.
  const withRunV2: OutcomeWithRun[] = [
    { runId: "run-2", runStartedAt: "2026-06-20T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "MISSING_DATA" },
  ];
  const byRunV2: Record<string, OutcomeRecord[]> = {
    "run-2": [{ id: "o-2", runId: "run-2", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-20", status: "MISSING_DATA", evidence: ev([["Dose Count", 1]]), evaluatedAt: "2026-06-20T00:00:00Z" }],
  };
  const third = await buildRoster({ outcomeStore: counting(withRunV2, byRunV2), segments: [], cellCache: cache }, { panel: "immunizations" });
  assert.equal(loadCount, 2, "a newer run supersedes the cache → recompute");
  assert.equal(third.rows.find((r) => r.subject.externalId === EMP)!.cells["mmr"]!.status, "IN_PROGRESS", "recomputed from the new run's evidence (1 of 2 doses)");
});

test("buildRoster — status filter keeps only subjects with >=1 matching cell; page-size bounds rows", async () => {
  const roster = await buildRoster({ outcomeStore: fakeStore([], {}), segments: [] }, { panel: "osha", status: "COMPLIANT", pageSize: 10 });
  assert.equal(roster.rows.length, 0);
  assert.equal(roster.total, 0);
});

test("buildRoster — subjects with real compliance data sort above all-NA rows (demo personas sink)", async () => {
  // emp-005 (Nadia Anwar) is a real employee but NOT first in the directory (emp-001..004 are the demo
  // login personas). Give only emp-005 a real cell — it must float above the all-NA demo personas.
  const REAL = "emp-005";
  const withRun: OutcomeWithRun[] = [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: REAL, measureId: "mmr", status: "COMPLIANT" },
  ];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      { id: "o-1", runId: "run-1", subjectId: REAL, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
    ],
  };
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun), segments: [] }, { panel: "immunizations", pageSize: 200 });
  const idxReal = roster.rows.findIndex((r) => r.subject.externalId === REAL);
  const idxDemo = roster.rows.findIndex((r) => r.subject.externalId === "emp-001"); // Demo Author — all NA
  assert.equal(idxReal, 0, "the only subject with a real cell floats to the top");
  assert.ok(idxReal < idxDemo, "all-NA demo persona sinks below the subject with data");
});

test("buildRoster — a demo persona WITH a compliant cell STILL sinks below a real all-NA employee (UX-1)", async () => {
  // The regression the marker fixes: an All-Employees segment can give a demo persona a Compliant cell.
  // A has-data heuristic would then float emp-001 to the top; the explicit demo marker must still sink it
  // below a real employee that has NO data in this panel.
  const DEMO = "emp-001"; // Demo Author
  const REAL = "emp-005"; // Nadia Anwar — no cell seeded here
  const withRun: OutcomeWithRun[] = [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: DEMO, measureId: "mmr", status: "COMPLIANT" },
  ];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      { id: "o-1", runId: "run-1", subjectId: DEMO, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
    ],
  };
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun), segments: [] }, { panel: "immunizations", pageSize: 200 });
  const idxDemo = roster.rows.findIndex((r) => r.subject.externalId === DEMO);
  const idxReal = roster.rows.findIndex((r) => r.subject.externalId === REAL);
  assert.ok(idxReal < idxDemo, "the demo persona sinks below the real all-NA employee despite having a compliant cell");
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

test("buildRoster — two panel measures sharing one run each read only their own rows of it (narrowed in SQL, one read per evaluated column); unevaluated measure → NA method", async () => {
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
  const calls: Array<[string, string | undefined]> = [];
  const orig = store.listOutcomes.bind(store);
  store.listOutcomes = async (id: string, opts?: { measureId?: string }) => { calls.push([id, opts?.measureId]); return orig(id, opts); };

  const roster = await buildRoster({ outcomeStore: store, segments: [] }, { panel: "immunizations" });
  // One narrowed read per EVALUATED column — the run is ALL_PROGRAMS, so reading it whole once would
  // ship every measure's evidence to serve two columns (the pilot's cold roster cost until 2026-09-10).
  // The unevaluated column has no winner and costs no read at all.
  assert.deepEqual(calls.sort(), [["run-1", "mmr"], ["run-1", "varicella"]], "listOutcomes(runId, { measureId }) once per evaluated column");
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
  const maui = await buildRoster({ outcomeStore: fakeStore([], {}), segments: [] }, { panel: "osha", tenant: "maui", pageSize: 200 });
  assert.equal(twh.total + ihn.total + maui.total, all.total, "twh + ihn + maui partitions the full directory");
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

// ── The panel filters reach the roster (spec §5) ──────────────────────────────
//
// `subject-filters.test.ts` proves the predicate. This proves the roster CALLS it — the half that goes
// missing silently, because a roster that ignores an unknown filter renders perfectly and simply shows
// everybody.

test("buildRoster applies providerId, and an unknown PCP returns no rows rather than all of them", async () => {
  const store = fakeStore([], {});
  const all = await buildRoster({ outcomeStore: store, segments: [] }, { pageSize: 100000 });
  assert.ok(all.total > 1, "the fixture roster must have rows for this to discriminate");

  const someone = EMPLOYEES.find((e) => e.providerId)!;
  const filtered = await buildRoster({ outcomeStore: store, segments: [] }, { providerId: someone.providerId, pageSize: 100000 });
  assert.ok(filtered.total > 0, "the PCP has a panel");
  assert.ok(filtered.total < all.total, "and it is not the whole roster");
  assert.ok(filtered.rows.every((r) => EMPLOYEES.find((e) => e.externalId === r.subject.externalId)?.providerId === someone.providerId));

  const unknown = await buildRoster({ outcomeStore: store, segments: [] }, { providerId: "prov-does-not-exist", pageSize: 100000 });
  assert.equal(unknown.total, 0, "an unknown PCP must not fall back to the unfiltered roster");
});

test("buildRoster applies ageBand and sex, and an unfiltered call is unchanged", async () => {
  const store = fakeStore([], {});
  const all = await buildRoster({ outcomeStore: store, segments: [] }, { pageSize: 100000 });
  // The default directory records no sex, so a sex filter there correctly matches nobody — which is
  // also the check that the filter is applied at all rather than ignored.
  const bySex = await buildRoster({ outcomeStore: store, segments: [] }, { sex: "F", pageSize: 100000 });
  assert.equal(bySex.total, 0, "the occupational directory records no sex — the filter must not match everyone");

  const banded = await buildRoster({ outcomeStore: store, segments: [] }, { ageBand: "65+", pageSize: 100000 });
  assert.ok(banded.total <= all.total);
  // The HTTP route refuses an unrecognised token with a 400 before the read model sees it; a caller that
  // bypasses the route gets a constraint NOBODY satisfies — an empty page is visible, the whole roster
  // under a filter that was silently dropped is not.
  assert.equal(
    (await buildRoster({ outcomeStore: store, segments: [] }, { ageBand: "not-a-band", pageSize: 100000 })).total,
    0,
    "an unrecognised band matches nobody, never everybody",
  );
});

/**
 * The pilot's quality staff opened a measure's roster and were handed thousands of patients the
 * measure does not describe. ADR-079 made those rows say OUT_OF_POPULATION instead of MISSING_DATA,
 * which is honest but still puts them in a work list: "if they don't fall in the measure, we don't
 * need to see them."
 *
 * So when ONE measure is in scope, a patient outside its population is not a row. The count is
 * returned rather than discarded (`notInPopulation`), because a shorter list with no explanation is
 * the failure mode this project keeps finding: absence that looks like data.
 *
 * Scope matters. On the multi-measure roster the row stays, because a patient outside CMS125's
 * population may be overdue on CMS122 — hiding the row there would hide the gap.
 */
test("buildRoster — a single-measure roster drops out-of-population rows and says how many", async () => {
  {
    const [inPop, outPop] = EMPLOYEES.filter((e) => !isDemoPersona(e.externalId)).slice(0, 2);
    const pop = (ipp: boolean) => ({
      expressionResults: [],
      official: { populationResults: { ipp, denom: ipp, denex: false, numer: false, denexcep: false } },
    });
    const withRun: OutcomeWithRun[] = [inPop!, outPop!].map((e) => ({
      runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS",
      runStatus: "COMPLETED", runTriggeredBy: "manual",
      subjectId: e.externalId, measureId: "cms125", status: "MISSING_DATA",
    }));
    const byRun: Record<string, OutcomeRecord[]> = {
      "run-1": [
        { id: "o1", runId: "run-1", subjectId: inPop!.externalId, measureId: "cms125", evaluationPeriod: "2026-01-01", status: "MISSING_DATA", evidence: pop(true), evaluatedAt: "2026-06-12T00:00:00Z" },
        { id: "o2", runId: "run-1", subjectId: outPop!.externalId, measureId: "cms125", evaluationPeriod: "2026-01-01", status: "MISSING_DATA", evidence: pop(false), evaluatedAt: "2026-06-12T00:00:00Z" },
      ],
    };
    const store = fakeStore(withRun, byRun);

    const scoped = await buildRoster({ outcomeStore: store, segments: [] }, { measureId: "cms125", pageSize: 100000 });
    const ids = scoped.rows.map((r) => r.subject.externalId);
    assert.ok(ids.includes(inPop!.externalId), "a patient the measure describes is still work");
    assert.ok(!ids.includes(outPop!.externalId), "a patient outside the population is not in the work list");
    assert.equal(scoped.notInPopulation, 1, "and the roster says how many it left out");
    assert.ok(!scoped.rows.some((r) => r.cells["cms125"]?.status === "OUT_OF_POPULATION"));

    // Asking FOR them is a different question, and it gets an answer.
    const asked = await buildRoster(
      { outcomeStore: store, segments: [] },
      { measureId: "cms125", status: "OUT_OF_POPULATION", pageSize: 100000 },
    );
    assert.deepEqual(asked.rows.map((r) => r.subject.externalId), [outPop!.externalId]);

    // A drill-down always carries a status, and the status filter already excludes an
    // out-of-population cell from every other bucket. The drop must NOT also run there, or the count
    // beside the list would describe the rows the status filter removed rather than the ones it kept.
    const drilled = await buildRoster(
      { outcomeStore: store, segments: [] },
      { measureId: "cms125", status: "MISSING_DATA", pageSize: 100000 },
    );
    assert.deepEqual(drilled.rows.map((r) => r.subject.externalId), [inPop!.externalId], "the in-population gap");
    assert.equal(drilled.notInPopulation, 0, "nothing was withheld from a status-filtered list");

    // The whole-panel roster is unchanged: the row stays, carrying its own cell.
    const panel = await buildRoster({ outcomeStore: store, segments: [] }, { pageSize: 100000 });
    assert.ok(panel.rows.map((r) => r.subject.externalId).includes(outPop!.externalId));
    assert.equal(panel.notInPopulation, 0, "nothing is hidden when no single measure is in scope");
  }
});
