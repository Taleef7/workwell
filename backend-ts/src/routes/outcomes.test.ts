/** Outcome evidence route — seed a minimal DB, call handleOutcomes, assert shape.
 *   node --import tsx --test src/routes/outcomes.test.ts */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { handleOutcomes } from "./outcomes.ts";

const dbPath = join(tmpdir(), `ww-outcomes-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let outcomeId = "";

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
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

test("non-outcomes path returns null (not this route)", async () => {
  assert.equal(await handleOutcomes(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

test("POST is not handled by this route", async () => {
  assert.equal(await handleOutcomes(new Request(`http://x/api/outcomes/${outcomeId}`, { method: "POST" }), env as never), null);
});

test("GET /api/outcomes/:id → { outcomeId, status, evidenceJson }", async () => {
  const res = (await handleOutcomes(new Request(`http://x/api/outcomes/${outcomeId}`, { method: "GET" }), env as never))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { outcomeId: string; status: string; evidenceJson: { expressionResults: Array<{ define: string; result: unknown }> } };
  assert.equal(body.outcomeId, outcomeId);
  assert.equal(body.status, "COMPLIANT");
  assert.equal(body.evidenceJson.expressionResults[0]!.define, "Dose Count");
});

test("GET unknown outcome id → 404", async () => {
  const res = (await handleOutcomes(new Request("http://x/api/outcomes/00000000-0000-0000-0000-000000000000", { method: "GET" }), env as never))!;
  assert.equal(res.status, 404);
});
