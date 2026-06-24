/** getOutcomeById round-trip on the SQLite floor.
 *   node --import tsx --test src/stores/sqlite/outcome-store-getbyid.test.ts */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./schema.ts";
import { SqliteRunStore } from "./run-store-sqlite.ts";
import { SqliteOutcomeStore } from "./outcome-store-sqlite.ts";

const dbPath = join(tmpdir(), `ww-outcome-getbyid-${crypto.randomUUID()}.sqlite`);
let outcomes: SqliteOutcomeStore;
let outcomeId = "";

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runStore = new SqliteRunStore(db);
  outcomes = new SqliteOutcomeStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "mmr", triggeredBy: "test", requestedScope: { measureId: "mmr" },
    measurementPeriodStart: "2026-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  const rec = await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-001", measureId: "mmr", status: "COMPLIANT", evaluationPeriod: "2026-06-12",
    evidence: { expressionResults: [{ define: "Dose Count", result: 2 }] },
  });
  outcomeId = rec.id;
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("getOutcomeById returns the record with parsed evidence", async () => {
  const o = await outcomes.getOutcomeById(outcomeId);
  assert.ok(o, "expected a record");
  assert.equal(o!.status, "COMPLIANT");
  assert.equal(o!.subjectId, "emp-001");
  assert.deepEqual(o!.evidence, { expressionResults: [{ define: "Dose Count", result: 2 }] });
});

test("getOutcomeById returns null for an unknown id", async () => {
  assert.equal(await outcomes.getOutcomeById("00000000-0000-0000-0000-000000000000"), null);
});
