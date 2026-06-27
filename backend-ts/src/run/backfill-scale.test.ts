/**
 * Generated population-scale backfill (#185 E13 PR-2): one COMPLETED run + N outcomes per runnable
 * measure, subject_id-encoded, audited, idempotent, bounded-aggregatable.
 *   node --import tsx --test src/run/backfill-scale.test.ts
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
import { backfillScalePopulation, SCALE_TRIGGER, SCALE_POPULATION_SEEDED_EVENT } from "./backfill-scale.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

async function fresh() {
  const dbPath = join(tmpdir(), `workwell-bscale-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return { dbPath, runs: new SqliteRunStore(db), outcomes: new SqliteOutcomeStore(db), events: new SqliteCaseEventStore(db) };
}

test("backfillScalePopulation writes one run + N outcomes per runnable measure, audited + idempotent", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events };
    const r1 = await backfillScalePopulation(deps, { subjects: 240, asOf: "2026-06-26" });
    const measures = Object.keys(MEASURES).length;
    assert.equal(r1.skipped, false);
    assert.equal(r1.runsCreated, measures, "one run per runnable measure");
    assert.equal(r1.outcomesCreated, measures * 240);

    // idempotent: a second run is a no-op
    const r2 = await backfillScalePopulation(deps, { subjects: 240, asOf: "2026-06-26" });
    assert.equal(r2.skipped, true);

    // audited
    const audits = await events.listAuditEvents(1000);
    assert.ok(audits.some((a) => a.eventType === SCALE_POPULATION_SEEDED_EVENT));

    // bounded aggregation over a scale run
    const scaleRun = (await runs.listRuns(1000)).find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    const groups = await outcomes.aggregateScaleRun(scaleRun.id);
    assert.ok(groups.length <= 24 * 10 * 5, `bounded group count, got ${groups.length}`);
    assert.equal(groups.reduce((s, g) => s + g.count, 0), 240, "groups sum to the subject count");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});
