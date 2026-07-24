/**
 * #263 Phase 2b — the PARITY suite (issue acceptance criterion + design §8): an incremental run must
 * produce byte-identical outcomes to a full run on the same data, and must re-evaluate exactly when
 * (and only when) the answer could have changed. A failure here is a CORRECTNESS bug, not a perf one.
 *
 * These run the REAL `CqlExecutionEngine`, a REAL SQLite `eval_state` + `outcomes` store, and the REAL
 * `IncrementalCache` — the only synthetic part is the input bundle, which is FIXED (built once and
 * reused at later dates) to model real WebChart data whose exam dates don't shift when you run the
 * report on a later day. (The synthetic run pipeline regenerates bundles per eval date, so its subjects'
 * data moves daily — across-day reuse is a real-data property, exercised here with fixed bundles.)
 *   node --import tsx --test src/run/incremental/parity.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../../stores/sqlite/schema.ts";
import { SqliteEvalStateStore } from "../../stores/sqlite/eval-state-store-sqlite.ts";
import { SqliteOutcomeStore } from "../../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../../stores/sqlite/run-store-sqlite.ts";
import { CqlExecutionEngine } from "../../engine/cql/cql-execution-engine.ts";
import { buildSyntheticBundle } from "../../engine/synthetic/fhir-bundle-builder.ts";
import { EMPLOYEES } from "../../engine/synthetic/employee-catalog.ts";
import { MEASURE_BINDINGS } from "../../engine/synthetic/measure-bindings.ts";
import type { ExamConfig } from "../../engine/synthetic/exam-config.ts";
import { IncrementalCache } from "./incremental-eval.ts";

const engine = new CqlExecutionEngine();
const emp = EMPLOYEES[0]!;
const created: string[] = [];

async function freshStores() {
  const dbPath = join(tmpdir(), `ww-parity-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return { evalState: new SqliteEvalStateStore(db), outcomes: new SqliteOutcomeStore(db), runs: new SqliteRunStore(db) };
}
process.on("exit", () => created.forEach((p) => { try { rmSync(p, { force: true }); } catch { /* best effort */ } }));

const PERIOD = "2026-01-01";
const newRunId = async (runs: SqliteRunStore): Promise<string> =>
  (await runs.createRun({
    scopeType: "MEASURE",
    triggeredBy: "parity",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2025-06-15T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-15T00:00:00.000Z",
  })).id;
const fixedBundle = (measureId: string, daysSinceLastExam: number | null): unknown => {
  const config: ExamConfig = {
    binding: MEASURE_BINDINGS[measureId]!,
    daysSinceLastExam,
    hasWaiver: false,
    programEnrolled: true,
    observationValue: null,
    refused: false,
    doseCount: null,
  };
  // Anchor to a fixed build date; the returned bundle carries ABSOLUTE dates that do NOT move later.
  return buildSyntheticBundle(emp, config, "2026-06-15");
};

const fullEvalStatus = async (measureId: string, bundle: unknown, date: string) =>
  (await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: date })).outcome;
const fullEvalEvidence = async (measureId: string, bundle: unknown, date: string) =>
  (await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: date })).evidence;

const daysSinceOf = (evidence: unknown): number | null => {
  const ers = (evidence as { expressionResults?: { define: string; result: unknown }[] }).expressionResults ?? [];
  const d = ers.find((r) => /^days since/i.test(r.define));
  return typeof d?.result === "number" ? d.result : null;
};

/**
 * Drive one incremental run for a subject: plan → reuse (copy forward) or evaluate (+commit). Records
 * the outcome to the store exactly as the pipeline does. Returns the recorded status/evidence + whether
 * it was reused.
 */
async function incrementalRun(
  stores: { evalState: SqliteEvalStateStore; outcomes: SqliteOutcomeStore; runs: SqliteRunStore },
  measureId: string,
  subjectId: string,
  bundle: unknown,
  date: string,
): Promise<{ status: string; evidence: unknown; reused: boolean }> {
  const runId = await newRunId(stores.runs);
  const cache = new IncrementalCache({ evalState: stores.evalState, outcomes: stores.outcomes, evalDate: date });
  const plan = await cache.plan(measureId, subjectId, PERIOD, bundle);
  if (plan.action === "reuse") {
    await stores.outcomes.recordOutcome({ runId, subjectId, measureId, evaluationPeriod: PERIOD, status: plan.status, evidence: plan.evidence, evaluatedAt: `${date}T00:00:00.000Z` });
    return { status: plan.status, evidence: plan.evidence, reused: true };
  }
  const r = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: date });
  const rec = await stores.outcomes.recordOutcome({ runId, subjectId, measureId, evaluationPeriod: PERIOD, status: r.outcome, evidence: r.evidence, evaluatedAt: `${date}T00:00:00.000Z` });
  await cache.commit(measureId, subjectId, PERIOD, r.outcome, rec.id, r.evidence, plan);
  return { status: r.outcome, evidence: r.evidence, reused: false };
}

test("§8.2 same-day reuse is byte-identical to the first evaluation, and IS a reuse", async () => {
  const stores = await freshStores();
  const bundle = fixedBundle("audiogram", 100); // COMPLIANT
  const first = await incrementalRun(stores, "audiogram", "s1", bundle, "2026-06-15");
  assert.equal(first.reused, false, "first run evaluates");
  const second = await incrementalRun(stores, "audiogram", "s1", bundle, "2026-06-15");
  assert.equal(second.reused, true, "second same-day run reuses");
  assert.equal(second.status, first.status);
  // Evidence identical modulo the provenance marker (delta 0 ⇒ no recompute).
  const { reusedFrom, ...secondEv } = second.evidence as Record<string, unknown>;
  assert.ok(reusedFrom, "carries the reusedFrom provenance marker (§7)");
  assert.deepEqual(secondEv, first.evidence);
});

test("§8.6 across-day reuse within the boundary: status held AND date-evidence matches a full run", async () => {
  const stores = await freshStores();
  const bundle = fixedBundle("audiogram", 100); // COMPLIANT, boundary far away
  await incrementalRun(stores, "audiogram", "s1", bundle, "2026-06-15");
  const later = "2026-07-15"; // +30 days, still well inside COMPLIANT
  const reused = await incrementalRun(stores, "audiogram", "s1", bundle, later);
  assert.equal(reused.reused, true, "reused across days (before the boundary)");
  assert.equal(reused.status, await fullEvalStatus("audiogram", bundle, later), "status equals a full run");
  // The stale-evidence trap: the copied Days Since must equal a full run's for the LATER date.
  assert.equal(daysSinceOf(reused.evidence), daysSinceOf(await fullEvalEvidence("audiogram", bundle, later)));
});

test("§8.5 clock past the boundary forces re-evaluation and the status flips (matches a full run)", async () => {
  const stores = await freshStores();
  const bundle = fixedBundle("audiogram", 330); // COMPLIANT now (<=335), DUE_SOON at day 336
  const first = await incrementalRun(stores, "audiogram", "s1", bundle, "2026-06-15");
  assert.equal(first.status, "COMPLIANT");
  const later = "2026-06-25"; // +10 days ⇒ day 340 ⇒ DUE_SOON, past next_transition_at
  const run2 = await incrementalRun(stores, "audiogram", "s1", bundle, later);
  assert.equal(run2.reused, false, "past the boundary ⇒ re-evaluate");
  assert.equal(run2.status, "DUE_SOON");
  assert.equal(run2.status, await fullEvalStatus("audiogram", bundle, later));
});

test("§8.3 a data change re-evaluates and matches a full run of the changed data", async () => {
  const stores = await freshStores();
  const compliant = fixedBundle("audiogram", 100);
  await incrementalRun(stores, "audiogram", "s1", compliant, "2026-06-15");
  // Different clinical data for the same (subject, measure, period): no qualifying exam ⇒ MISSING_DATA.
  const changed = fixedBundle("audiogram", null);
  const run2 = await incrementalRun(stores, "audiogram", "s1", changed, "2026-06-15");
  assert.equal(run2.reused, false, "changed data ⇒ hash mismatch ⇒ re-evaluate");
  assert.equal(run2.status, await fullEvalStatus("audiogram", changed, "2026-06-15"));
  assert.notEqual(run2.status, "COMPLIANT");
});

test("§3 a stale logic_version re-evaluates every subject for that measure", async () => {
  const stores = await freshStores();
  const bundle = fixedBundle("audiogram", 100);
  await incrementalRun(stores, "audiogram", "s1", bundle, "2026-06-15");
  // Simulate a measure-logic change: overwrite the stored logic_version with a stale one.
  const row = (await stores.evalState.getEvalState("s1", "audiogram", PERIOD))!;
  await stores.evalState.upsertEvalState({ ...row, logicVersion: "sha256:STALE" });
  const run2 = await incrementalRun(stores, "audiogram", "s1", bundle, "2026-06-15");
  assert.equal(run2.reused, false, "logic_version mismatch ⇒ re-evaluate even same-day on identical data");
});

test("§8 terminal statuses (OVERDUE) reuse across a long gap with date-corrected evidence", async () => {
  const stores = await freshStores();
  const bundle = fixedBundle("audiogram", 400); // OVERDUE (terminal: next_transition_at = null)
  const first = await incrementalRun(stores, "audiogram", "s1", bundle, "2026-06-15");
  assert.equal(first.status, "OVERDUE");
  const later = "2027-06-15"; // +365 days
  const reused = await incrementalRun(stores, "audiogram", "s1", bundle, later);
  assert.equal(reused.reused, true, "terminal status reuses across days");
  assert.equal(reused.status, "OVERDUE");
  assert.equal(daysSinceOf(reused.evidence), daysSinceOf(await fullEvalEvidence("audiogram", bundle, later)), "Days Since advanced to match a full run");
});

test("§8 a PERMANENT measure (series complete) reuses across days (date-invariant)", async () => {
  const stores = await freshStores();
  const config: ExamConfig = { binding: MEASURE_BINDINGS["mmr"]!, daysSinceLastExam: 3000, hasWaiver: false, programEnrolled: true, observationValue: null, refused: false, doseCount: 2 };
  const bundle = buildSyntheticBundle(emp, config, "2026-06-15");
  const first = await incrementalRun(stores, "mmr", "s1", bundle, "2026-06-15");
  assert.equal(first.status, "COMPLIANT");
  const reused = await incrementalRun(stores, "mmr", "s1", bundle, "2028-06-15");
  assert.equal(reused.reused, true, "PERMANENT complete reuses indefinitely on unchanged data");
  assert.equal(reused.status, "COMPLIANT");
});
