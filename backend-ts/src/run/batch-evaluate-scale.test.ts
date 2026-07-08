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
import { batchEvaluateScalePopulation, SCALE_TRIGGER } from "./batch-evaluate-scale.ts";
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

test("batchEvaluateScalePopulation trimEvidence writes {scale:true}; default writes real engine evidence", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    // trimEvidence:true → minimal evidence on every (successfully-evaluated) row.
    const trimDeps = { runStore: runs, outcomeStore: outcomes, auditStore: events, generator: directSyntheticGenerator() };
    await batchEvaluateScalePopulation(trimDeps, { subjects: 8, asOf: "2026-06-26", chunkSize: 8, trimEvidence: true });
    const trimRun = (await runs.listRuns(1000)).find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    const trimRows = await outcomes.listOutcomes(trimRun.id);
    assert.ok(trimRows.length > 0);
    for (const row of trimRows) {
      assert.deepEqual(row.evidence, { scale: true }, "trimEvidence writes minimal {scale:true}");
    }
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
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
