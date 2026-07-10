/**
 * Batch live-evaluation of the mhn population-scale tenant (#185 E13 PR-2): REAL CQL outcomes per
 * subject × measure, subject_id-encoded, audited, per-measure idempotent, bounded-aggregatable.
 *   node --import tsx --test src/run/batch-evaluate-scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { batchEvaluateScalePopulation, applyEvidenceTier, SCALE_TRIGGER } from "./batch-evaluate-scale.ts";
import { directSyntheticGenerator, webChartRealisticGenerator, type ScaleSubjectGenerator } from "./scale-generator.ts";
import type { FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { encodeScaleSubject } from "../engine/synthetic/scale-structure.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

const VALID_BUCKETS = new Set(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"]);

/** A generator that returns a deliberately-malformed bundle for one subjectId (the real engine then
 *  throws on it), delegating every other subject to the real synthetic generator. */
function failingGenerator(failSubjectId: string): ScaleSubjectGenerator {
  const base = directSyntheticGenerator();
  return {
    kind: "failing-test",
    bundleFor(subjectId, measureId, target, evaluationDate): FhirBundle {
      if (subjectId === failSubjectId) return {} as unknown as FhirBundle; // engine throws → per-item isolation
      return base.bundleFor(subjectId, measureId, target, evaluationDate);
    },
  };
}

async function fresh() {
  const dbPath = join(tmpdir(), `workwell-batchscale-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return { dbPath, runs: new SqliteRunStore(db), outcomes: new SqliteOutcomeStore(db), events: new SqliteCaseEventStore(db) };
}

test("batchEvaluateScalePopulation rejects a non-positive chunkSize or subjects (exported-API guard)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    // chunkSize 0 would dead-loop `off += chunk`; negative goes backward. Both must reject up front.
    await assert.rejects(() => batchEvaluateScalePopulation(deps, { subjects: 10, asOf: "2026-06-26", chunkSize: 0 }), /chunkSize must be a positive integer/);
    await assert.rejects(() => batchEvaluateScalePopulation(deps, { subjects: 10, asOf: "2026-06-26", chunkSize: -5 }), /chunkSize must be a positive integer/);
    await assert.rejects(() => batchEvaluateScalePopulation(deps, { subjects: 0, asOf: "2026-06-26", chunkSize: 5 }), /subjects must be a positive integer/);
    // The guard fires before any run is created (no side effects on a bad call).
    assert.equal((await runs.listRuns(1000)).length, 0);
  } finally {
    // Best-effort: on Windows the open SQLite handle can EPERM an immediate delete; a temp file is harmless.
    try { rmSync(dbPath, { force: true }); } catch { /* leftover temp sqlite is harmless */ }
  }
});

test("batchEvaluateScalePopulation writes one COMPLETED run + N real outcomes per runnable measure", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    const r = await batchEvaluateScalePopulation(deps, { subjects: 20, asOf: "2026-06-26", chunkSize: 5 });
    const measures = Object.keys(MEASURES).length;
    assert.equal(r.skipped, false);
    assert.equal(r.runsCreated, measures, "one run per runnable measure");
    assert.equal(r.outcomesCreated, measures * 20, "outcomesCreated === runsCreated * subjects");

    const scaleRuns = (await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER);
    assert.equal(scaleRuns.length, measures);
    assert.ok(scaleRuns.every((x) => x.status === "COMPLETED"), "all seed:scale runs COMPLETED");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation writes valid CQL bucket statuses (real evaluation)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    await batchEvaluateScalePopulation(deps, { subjects: 20, asOf: "2026-06-26", chunkSize: 5 });

    const scaleRun = (await runs.listRuns(1000)).find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    const rows = await outcomes.listOutcomes(scaleRun.id);
    assert.ok(rows.length > 0, "the run has outcomes");
    for (const row of rows) {
      assert.ok(VALID_BUCKETS.has(row.status), `written status is a valid bucket, got '${row.status}'`);
    }
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation is resumable — a second identical call is a no-op", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    const r1 = await batchEvaluateScalePopulation(deps, { subjects: 20, asOf: "2026-06-26", chunkSize: 5 });
    assert.equal(r1.skipped, false);

    const r2 = await batchEvaluateScalePopulation(deps, { subjects: 20, asOf: "2026-06-26", chunkSize: 5 });
    assert.equal(r2.skipped, true);
    assert.equal(r2.runsCreated, 0);
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("RESUME (#256): a killed-mid-run batch (stranded RUNNING runs) re-runs to completion without duplicate COMPLETED runs", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    // Simulate a prior invocation killed mid-batch: it created its per-measure runs RUNNING (as the
    // real batch does up front) and wrote some outcomes, but never reached the finalize loop — so NO
    // COMPLETED batch-evaluated run exists. This is exactly the crash state a process kill leaves.
    const stranded = await runs.createRun({
      scopeType: "MEASURE",
      scopeId: "audiogram",
      triggeredBy: SCALE_TRIGGER,
      status: "RUNNING",
      startedAt: "2026-06-26T00:00:00.000Z",
      requestedScope: { measureId: "audiogram", scalePopulation: true, batchEvaluated: true },
      measurementPeriodStart: "2025-06-26T00:00:00.000Z",
      measurementPeriodEnd: "2026-06-26T00:00:00.000Z",
    });
    await outcomes.recordOutcomes([
      { runId: stranded.id, subjectId: encodeScaleSubject(0, 0, 0), measureId: "audiogram", evaluationPeriod: "2026-06-26", status: "COMPLIANT", evidence: { scale: true } },
    ]);

    // Re-run (the resume): the idempotency check counts only COMPLETED batch-evaluated runs, so ALL
    // measures are re-seeded under fresh run ids and finalize COMPLETED (works identically with the
    // worker pool — the DB-write/finalize side is main-thread on both paths).
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    const r = await batchEvaluateScalePopulation(deps, { subjects: 6, asOf: "2026-06-26", chunkSize: 3, workers: 2 });
    const measures = Object.keys(MEASURES).length;
    assert.equal(r.skipped, false, "a crashed batch is resumed, not skipped");
    assert.equal(r.runsCreated, measures, "every measure re-seeded");
    assert.equal(r.outcomesCreated, measures * 6);

    const scaleRuns = (await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER);
    const completed = scaleRuns.filter((x) => x.status === "COMPLETED");
    assert.equal(completed.length, measures, "exactly ONE COMPLETED run per measure — no duplicates");
    assert.equal(new Set(completed.map((x) => x.scopeId)).size, measures, "COMPLETED runs cover distinct measures");
    // The stranded RUNNING run is left as-is (failStuckRuns excludes seed:% — documented; rollup is
    // COMPLETED-only latest-wins, so it never double-counts).
    assert.ok(scaleRuns.some((x) => x.id === stranded.id && x.status === "RUNNING"), "the stranded run is not resurrected");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation REFUSES over legacy FABRICATED seed:scale runs (rollback-required)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    // Simulate the legacy fabricated path (backfill-scale.ts): a COMPLETED seed:scale run WITHOUT the
    // batchEvaluated marker. --mode evaluate must fail loudly over it rather than silently no-op.
    await runs.createRun({
      scopeType: "MEASURE",
      scopeId: "audiogram",
      triggeredBy: SCALE_TRIGGER,
      status: "COMPLETED",
      startedAt: "2026-06-26T00:00:00.000Z",
      completedAt: "2026-06-26T00:01:00.000Z",
      requestedScope: { measureId: "audiogram", scalePopulation: true }, // fabricated: no batchEvaluated
      measurementPeriodStart: "2025-06-26T00:00:00.000Z",
      measurementPeriodEnd: "2026-06-26T00:00:00.000Z",
    });
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    await assert.rejects(
      () => batchEvaluateScalePopulation(deps, { subjects: 10, asOf: "2026-06-26", chunkSize: 5 }),
      /legacy FABRICATED seed:scale runs exist/,
    );
    // It refused BEFORE creating any evaluate run — still only the one fabricated run present.
    assert.equal((await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER).length, 1);
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation tolerates a failing audit store (best-effort audit, still finalizes)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    // An audit store whose appendAudit always throws. finalizeRun runs before appendAudit, so a failed
    // audit must NOT strand the remaining runs unfinalized — the batch logs a WARN and continues.
    const throwingAudit = new Proxy(events, {
      get(target, prop, recv) {
        if (prop === "appendAudit") return async () => { throw new Error("audit ledger down"); };
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof events;
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: throwingAudit, generator: directSyntheticGenerator() };
    const r = await batchEvaluateScalePopulation(deps, { subjects: 10, asOf: "2026-06-26", chunkSize: 5 });
    const measures = Object.keys(MEASURES).length;
    assert.equal(r.skipped, false, "the batch is not skipped");
    assert.equal(r.runsCreated, measures);

    const scaleRuns = (await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER);
    assert.equal(scaleRuns.length, measures);
    assert.ok(scaleRuns.every((x) => x.status === "COMPLETED"), "all runs finalize COMPLETED despite the audit failure");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation isolates a per-subject evaluation failure (MISSING_DATA, run still COMPLETED)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    // subject index 0 → provider pair {li:0,pi:0} → this encoded id (see PROVIDER_PAIRS ordering).
    const failSubjectId = encodeScaleSubject(0, 0, 0);
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: failingGenerator(failSubjectId) };
    const r = await batchEvaluateScalePopulation(deps, { subjects: 10, asOf: "2026-06-26", chunkSize: 4 });
    const measures = Object.keys(MEASURES).length;
    // The batch continues past the failure: every subject×measure row is still persisted.
    assert.equal(r.outcomesCreated, measures * 10, "failed subjects are still persisted, batch not aborted");

    const scaleRuns = (await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER);
    assert.ok(scaleRuns.every((x) => x.status === "COMPLETED"), "the run finalizes COMPLETED despite a failure");

    // The failed subject's rows are MISSING_DATA with evaluation-error evidence (DATA_MODEL §5 shape).
    let sawFail = false;
    let sawRealOutcome = false;
    for (const run of scaleRuns) {
      for (const row of await outcomes.listOutcomes(run.id)) {
        if (row.subjectId === failSubjectId) {
          assert.equal(row.status, "MISSING_DATA", "failed subject is MISSING_DATA");
          const ev = row.evidence as { evaluationError?: string; message?: string };
          assert.ok(ev.evaluationError, "failed subject carries evidenceJson.evaluationError");
          assert.ok(typeof ev.message === "string", "failed subject carries an error message");
          sawFail = true;
        } else {
          sawRealOutcome = true;
        }
      }
    }
    assert.ok(sawFail, "the failing subject produced error rows");
    assert.ok(sawRealOutcome, "other subjects still produced outcomes");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation handles a remainder chunk (subjects not divisible by chunkSize)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    // 20 / 7 = chunks of 7, 7, 6 — the trailing remainder chunk must still flush.
    const r = await batchEvaluateScalePopulation(deps, { subjects: 20, asOf: "2026-06-26", chunkSize: 7 });
    const measures = Object.keys(MEASURES).length;
    assert.equal(r.runsCreated, measures);
    assert.equal(r.outcomesCreated, measures * 20, "outcomesCreated === runsCreated * subjects across the remainder");

    // Each measure's run holds exactly `subjects` rows (no drops, no dupes at the chunk boundary).
    const scaleRun = (await runs.listRuns(1000)).find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    assert.equal((await outcomes.listOutcomes(scaleRun.id)).length, 20);
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation trimEvidence applies the TIERED policy (#257): actionable + ~1%-sample rows keep full evidence, other COMPLIANT/EXCLUDED get {scale:true}", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const trimDeps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    await batchEvaluateScalePopulation(trimDeps, { subjects: 8, asOf: "2026-06-26", chunkSize: 8, trimEvidence: true });
    const scaleRuns = (await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER);
    const subjectIndexOf = (subjectId: string) => Number(subjectId.split("|")[3]);
    let sawTrimmed = false;
    let sawActionableFull = false;
    for (const run of scaleRuns) {
      for (const row of await outcomes.listOutcomes(run.id)) {
        const idx = subjectIndexOf(row.subjectId);
        const isSample = idx % 100 === 0; // subject index 0 in this 8-subject run
        const isActionable = ["OVERDUE", "DUE_SOON", "MISSING_DATA"].includes(row.status);
        if (isSample || isActionable) {
          assert.notDeepEqual(row.evidence, { scale: true }, `full-tier row (idx ${idx}, ${row.status}) keeps full evidence`);
          if (isActionable && !isSample) sawActionableFull = true;
        } else {
          assert.deepEqual(row.evidence, { scale: true }, `COMPLIANT/EXCLUDED non-sample row (idx ${idx}, ${row.status}) is trimmed`);
          sawTrimmed = true;
        }
      }
    }
    assert.ok(sawTrimmed, "at least one row was trimmed to {scale:true}");
    assert.ok(sawActionableFull, "at least one actionable non-sample row kept full evidence");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("applyEvidenceTier (#257): pure tier assignment per status + deterministic ~1% sample + no-trim passthrough", () => {
  const full = { expressionResults: [{ define: "Outcome Status", result: "COMPLIANT" }] };
  // trim=false → passthrough for every status and index.
  for (const s of ["COMPLIANT", "EXCLUDED", "OVERDUE", "DUE_SOON", "MISSING_DATA"]) {
    assert.equal(applyEvidenceTier(7, s, full, false), full, `no-trim passes through (${s})`);
  }
  // Actionable statuses keep FULL evidence when trimming (they feed cases/worklists).
  for (const s of ["OVERDUE", "DUE_SOON", "MISSING_DATA"]) {
    assert.equal(applyEvidenceTier(7, s, full, true), full, `${s} keeps full evidence under trim`);
  }
  // COMPLIANT / EXCLUDED are trimmed to the minimal sentinel (non-sample index).
  for (const s of ["COMPLIANT", "EXCLUDED"]) {
    assert.deepEqual(applyEvidenceTier(7, s, full, true), { scale: true }, `${s} trims to {scale:true}`);
  }
  // Deterministic ~1% audit sample: idx % 100 === 0 keeps full evidence across ALL buckets.
  for (const s of ["COMPLIANT", "EXCLUDED", "OVERDUE", "DUE_SOON", "MISSING_DATA"]) {
    assert.equal(applyEvidenceTier(0, s, full, true), full, `sample idx 0 keeps full (${s})`);
    assert.equal(applyEvidenceTier(100, s, full, true), full, `sample idx 100 keeps full (${s})`);
    assert.equal(applyEvidenceTier(119900, s, full, true), full, `sample idx 119900 keeps full (${s})`);
  }
  // Determinism: same inputs → same decision every call (pure function of (idx, status, trim)).
  assert.deepEqual(applyEvidenceTier(42, "COMPLIANT", full, true), applyEvidenceTier(42, "COMPLIANT", full, true), "non-sample compliant rows trim identically");
  assert.deepEqual(applyEvidenceTier(42, "COMPLIANT", full, true), { scale: true });
  assert.deepEqual(applyEvidenceTier(101, "EXCLUDED", full, true), { scale: true }, "idx 101 is not in the sample");
  // An evaluation-error MISSING_DATA keeps its {evaluationError} payload (full tier).
  const err = { evaluationError: "CQL engine failure", message: "boom" };
  assert.equal(applyEvidenceTier(55, "MISSING_DATA", err, true), err);
});

test("TRIMMED run's aggregation is UNCHANGED (#257): aggregateScaleRun reads status only — trim vs full produce identical groups", async () => {
  const trimmed = await fresh();
  const untrimmed = await fresh();
  try {
    const args = { subjects: 8, asOf: "2026-06-26", chunkSize: 4 };
    await batchEvaluateScalePopulation(
      { runStore: trimmed.runs, outcomeStore: trimmed.outcomes, auditStore: trimmed.events, generator: directSyntheticGenerator() },
      { ...args, trimEvidence: true },
    );
    await batchEvaluateScalePopulation(
      { runStore: untrimmed.runs, outcomeStore: untrimmed.outcomes, auditStore: untrimmed.events, generator: directSyntheticGenerator() },
      { ...args },
    );
    // Per measure, the (location, provider, status, count) groups must be identical — the rollup read
    // path never touches evidence_json, so the tier provably cannot change it.
    const groupsByMeasure = async (runs: SqliteRunStore, outcomes: SqliteOutcomeStore) => {
      const out = new Map<string, string[]>();
      for (const run of (await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER)) {
        const groups = await outcomes.aggregateScaleRun(run.id);
        out.set(run.scopeId as string, groups.map((g) => `${g.locationId}|${g.providerId}|${g.status}|${g.count}`).sort());
      }
      return out;
    };
    const a = await groupsByMeasure(trimmed.runs, trimmed.outcomes);
    const b = await groupsByMeasure(untrimmed.runs, untrimmed.outcomes);
    assert.ok(a.size > 0, "trimmed run produced aggregations");
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), "same measures aggregated");
    for (const [measureId, groups] of a) {
      assert.deepEqual(groups, b.get(measureId), `aggregateScaleRun groups identical for ${measureId} (trim vs full)`);
    }
  } finally {
    try { rmSync(trimmed.dbPath, { force: true }); } catch { /* best effort */ }
    try { rmSync(untrimmed.dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation default (no trimEvidence) persists the real engine evidence", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    await batchEvaluateScalePopulation(deps, { subjects: 8, asOf: "2026-06-26", chunkSize: 8 });
    const scaleRun = (await runs.listRuns(1000)).find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    const rows = await outcomes.listOutcomes(scaleRun.id);
    assert.ok(rows.length > 0);
    // Real evidence carries the CQL define results — not the minimal {scale:true} sentinel.
    const ev = rows[0]!.evidence as { expressionResults?: unknown };
    assert.ok(Array.isArray(ev.expressionResults), "default evidence has expressionResults");
    assert.notDeepEqual(rows[0]!.evidence, { scale: true });
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation with webChartRealisticGenerator produces a real status spread (crosswalk works at scale)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    // The WebChart-real-coded generator routes REAL LOINC/CVX/CPT codes through the terminology
    // crosswalk. If reconciliation failed, every outcome would collapse to a uniform MISSING_DATA;
    // a real spread (≥2 distinct statuses) proves the real codes actually matched the CQL at scale.
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: webChartRealisticGenerator() };
    const r = await batchEvaluateScalePopulation(deps, { subjects: 24, asOf: "2026-06-26", chunkSize: 8 });
    assert.equal(r.skipped, false, "the batch is not skipped");
    assert.equal(r.outcomesCreated, Object.keys(MEASURES).length * 24);

    // Pick a measure's run and assert its outcomes span >1 distinct status.
    const scaleRun = (await runs.listRuns(1000)).find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    const rows = await outcomes.listOutcomes(scaleRun.id);
    assert.ok(rows.length > 0, "the run has outcomes");
    for (const row of rows) {
      assert.ok(VALID_BUCKETS.has(row.status), `written status is a valid bucket, got '${row.status}'`);
    }
    const distinct = new Set(rows.map((row) => row.status));
    assert.ok(
      distinct.size >= 2,
      `webchart-generated run has a real status spread, not uniform MISSING_DATA — saw ${[...distinct].join(",")}`,
    );
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("batchEvaluateScalePopulation outcomes reconcile via bounded aggregateScaleRun", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    await batchEvaluateScalePopulation(deps, { subjects: 40, asOf: "2026-06-26", chunkSize: 10 });

    const scaleRun = (await runs.listRuns(1000)).find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    const groups = await outcomes.aggregateScaleRun(scaleRun.id);
    assert.equal(groups.reduce((s, g) => s + g.count, 0), 40, "group counts sum to the subject count");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

/** Collect a stable (subjectId, measureId, status) fingerprint of every seed:scale outcome row. */
async function outcomeFingerprint(runs: SqliteRunStore, outcomes: SqliteOutcomeStore): Promise<string[]> {
  const scaleRuns = (await runs.listRuns(5000)).filter((x) => x.triggeredBy === SCALE_TRIGGER);
  const keys: string[] = [];
  for (const run of scaleRuns) for (const row of await outcomes.listOutcomes(run.id)) keys.push(`${row.subjectId}|${row.measureId}|${row.status}`);
  return keys.sort();
}

test("PARITY (#256): --workers 2 produces the identical (subject, measure, status) outcome set as --workers 1", async () => {
  // Small N (real CQL eval is ~60ms/eval) — the worker pool must yield the SAME outcome set as the
  // sequential path for the same N + as-of. The direct-synthetic generator is reconstructable in a worker.
  const seq = await fresh();
  const par = await fresh();
  try {
    const args = { subjects: 6, asOf: "2026-06-26", chunkSize: 2 };
    await batchEvaluateScalePopulation(
      { runStore: seq.runs, outcomeStore: seq.outcomes, auditStore: seq.events, generator: directSyntheticGenerator() },
      { ...args, workers: 1 },
    );
    await batchEvaluateScalePopulation(
      { runStore: par.runs, outcomeStore: par.outcomes, auditStore: par.events, generator: directSyntheticGenerator() },
      { ...args, workers: 2 },
    );
    const seqFp = await outcomeFingerprint(seq.runs, seq.outcomes);
    const parFp = await outcomeFingerprint(par.runs, par.outcomes);
    assert.ok(seqFp.length > 0, "the sequential run produced outcomes");
    assert.deepEqual(parFp, seqFp, "workers:2 outcome set is identical to workers:1 (subject, measure, status)");
  } finally {
    try { rmSync(seq.dbPath, { force: true }); } catch { /* best effort */ }
    try { rmSync(par.dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("WORKER PATH (#256): --workers 2 writes the full outcome set, COMPLETED runs, and reconciles", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    const r = await batchEvaluateScalePopulation(deps, { subjects: 8, asOf: "2026-06-26", chunkSize: 3, workers: 2 });
    const measures = Object.keys(MEASURES).length;
    assert.equal(r.skipped, false);
    assert.equal(r.runsCreated, measures, "one run per runnable measure");
    assert.equal(r.outcomesCreated, measures * 8, "every subject×measure row persisted via the pool");

    const scaleRuns = (await runs.listRuns(1000)).filter((x) => x.triggeredBy === SCALE_TRIGGER);
    assert.equal(scaleRuns.length, measures);
    assert.ok(scaleRuns.every((x) => x.status === "COMPLETED"), "all runs COMPLETED (main thread finalizes)");
    // The aggregateScaleRun (status-only) read path is unchanged: group counts sum to the subject count.
    const groups = await outcomes.aggregateScaleRun(scaleRuns[0]!.id);
    assert.equal(groups.reduce((s, g) => s + g.count, 0), 8, "worker-path outcomes reconcile via aggregateScaleRun");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("WORKER PATH (#256): rejects a non-reconstructable generator kind up front (fail-fast, no silent MISSING_DATA)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    // A generator whose kind a worker can't rebuild from a string — the pool must refuse, not degrade.
    const badGen: ScaleSubjectGenerator = { kind: "failing-test", bundleFor: () => ({} as unknown as FhirBundle) };
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: badGen };
    await assert.rejects(
      () => batchEvaluateScalePopulation(deps, { subjects: 4, asOf: "2026-06-26", chunkSize: 2, workers: 2 }),
      /reconstructable generator kind/,
    );
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});

test("WORKER PATH (#256): workers:1 takes the unchanged sequential path (escape hatch)", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    // workers:1 must behave exactly like omitting workers (no thread spawned) — same counts.
    const r = await batchEvaluateScalePopulation(deps, { subjects: 6, asOf: "2026-06-26", chunkSize: 2, workers: 1 });
    assert.equal(r.runsCreated, Object.keys(MEASURES).length);
    assert.equal(r.outcomesCreated, Object.keys(MEASURES).length * 6);
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});
