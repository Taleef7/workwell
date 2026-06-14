/**
 * Floor schema upgrade-path test (#107). Proves migrateFloorSchema backfills columns
 * added after a table's initial release — the case Codex flagged: a DB created by an
 * older release keeps the old shape, so a SELECT of a new column would fail.
 *   node --import tsx --test src/stores/sqlite/migrate.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { migrateFloorSchema } from "./schema.ts";
import { SqliteCaseStore } from "./case-store-sqlite.ts";

const created: string[] = [];
async function oldShapeDb() {
  const dbPath = join(tmpdir(), `workwell-migrate-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  // The PRE-closed_reason/closed_by cases table (the shape shipped in PR #122/#124).
  await db.exec(
    "CREATE TABLE cases (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, measure_id TEXT NOT NULL, " +
      "evaluation_period TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, assignee TEXT, " +
      "next_action TEXT, current_outcome_status TEXT NOT NULL, last_run_id TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, " +
      "UNIQUE (employee_id, measure_id, evaluation_period))",
  );
  return db;
}
after(() => {
  for (const p of created) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("migrateFloorSchema backfills closed_reason/closed_by on an existing cases table (idempotent)", async () => {
  const db = await oldShapeDb();
  await migrateFloorSchema(db);
  await migrateFloorSchema(db); // second run must be a no-op, not a duplicate-column error

  const store = new SqliteCaseStore(db);
  const c = (await store.upsertFromOutcome({
    runId: crypto.randomUUID(),
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    outcomeStatus: "OVERDUE",
  }))!;
  // SELECT now includes closed_reason/closed_by — would throw "no such column" pre-migration.
  assert.equal(c.closedReason, null);
  assert.equal(c.closedBy, null);
  const closed = await store.patchCase(c.id, { closedReason: "RERUN_VERIFIED", closedBy: "cm@workwell.dev" });
  assert.equal(closed?.closedReason, "RERUN_VERIFIED");
  assert.equal(closed?.closedBy, "cm@workwell.dev");
});

test("migrateFloorSchema backfills outcomes.evaluation_period on an existing outcomes table", async () => {
  const db = await createSqliteD1(join(tmpdir(), `workwell-migrate-oc-${crypto.randomUUID()}.sqlite`));
  // PRE-evaluation_period outcomes table (the shape shipped before the risk-outlook slice).
  await db.exec(
    "CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT, " +
      "triggered_by TEXT, requested_scope_json TEXT NOT NULL DEFAULT '{}', measurement_period_start TEXT NOT NULL, " +
      "measurement_period_end TEXT NOT NULL, claimed_by TEXT, started_at TEXT NOT NULL, completed_at TEXT)",
  );
  await db.exec(
    "CREATE TABLE outcomes (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, subject_id TEXT NOT NULL, " +
      "measure_id TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL, evaluated_at TEXT NOT NULL)",
  );
  await migrateFloorSchema(db);
  await migrateFloorSchema(db); // idempotent

  const { SqliteRunStore } = await import("./run-store-sqlite.ts");
  const { SqliteOutcomeStore } = await import("./outcome-store-sqlite.ts");
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "t",
    requestedScope: {},
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  const oc = new SqliteOutcomeStore(db);
  // SELECT/INSERT now reference evaluation_period — would throw "no such column" pre-migration.
  await oc.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", status: "OVERDUE", evidence: {} });
  const rows = await oc.listOutcomesForMeasure("audiogram");
  assert.equal(rows[0]!.evaluationPeriod, "2026-06-13");
});
