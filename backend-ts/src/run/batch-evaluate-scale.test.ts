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
import { directSyntheticGenerator } from "./scale-generator.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

const VALID_BUCKETS = new Set(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"]);

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
