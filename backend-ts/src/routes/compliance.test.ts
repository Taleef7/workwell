/**
 * Compliance roster route (E10.2) — seed a minimal DB, call handleCompliance, assert shape.
 *   node --import tsx --test src/routes/compliance.test.ts
 */
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
import { handleCompliance } from "./compliance.ts";

const dbPath = join(tmpdir(), `workwell-roster-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (qs = "") => handleCompliance(new Request(`http://x/api/compliance/roster${qs}`, { method: "GET" }), env as never);

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
  await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-001", measureId: "mmr", status: "COMPLIANT", evaluationPeriod: "2026-06-12",
    evidence: { expressionResults: [{ define: "Dose Count", result: 2 }] },
  });
  // The roster only reads terminal (COMPLETED/PARTIAL_FAILURE) population runs — finalize so the cell shows.
  await runStore.finalizeRun(run.id, "COMPLETED");
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("non-roster path returns null (not this route)", async () => {
  assert.equal(await handleCompliance(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

test("POST is not handled by this route", async () => {
  assert.equal(await handleCompliance(new Request("http://x/api/compliance/roster", { method: "POST" }), env as never), null);
});

test("GET /api/compliance/roster → columns + rows + X-Total-Count; mmr cell carries the dose method", async () => {
  const res = (await get("?panel=immunizations&pageSize=200"))!;
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("X-Total-Count"));
  const body = (await res.json()) as {
    panel: string;
    columns: Array<{ measureId: string; complianceClass: string }>;
    rows: Array<{ subject: { externalId: string }; cells: Record<string, { status: string; method: string }> }>;
  };
  assert.equal(body.panel, "immunizations");
  assert.ok(body.columns.some((c) => c.measureId === "mmr" && c.complianceClass === "PERMANENT"));
  const row = body.rows.find((r) => r.subject.externalId === "emp-001")!;
  const mmrCell = row.cells["mmr"]!;
  assert.equal(mmrCell.status, "COMPLIANT");
  assert.equal(mmrCell.method, "2 valid dose(s)");
});
