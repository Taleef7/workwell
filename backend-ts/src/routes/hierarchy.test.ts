/**
 * Hierarchy route (#74 E4): seed an audiogram run + outcomes + an open case, then assert
 * GET /api/hierarchy/rollup returns the enterprise tree, reconciles through the API, and
 * honors the measureId filter.
 *   node --import tsx --test src/routes/hierarchy.test.ts
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
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { handleHierarchy } from "./hierarchy.ts";

const dbPath = join(tmpdir(), `workwell-hier-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (qs = "") => handleHierarchy(new Request(`http://x/api/hierarchy/rollup${qs}`, { method: "GET" }), env as never);

interface Node { level: string; id: string; totals: { evaluated: number; compliant: number; complianceRate: number; openCases: number }; children: Node[]; }

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const cases = new SqliteCaseStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("GET /api/hierarchy/rollup returns the All-Systems tree, reconciling, filtered by measure", async () => {
  const res = await get("?measureId=audiogram");
  assert.equal(res?.status, 200);
  const root = (await res!.json()) as Node;
  assert.equal(root.level, "all");
  assert.equal(root.totals.evaluated, 2);
  assert.equal(root.totals.compliant, 1);
  assert.equal(root.totals.complianceRate, 50);
  assert.equal(root.totals.openCases, 1);
  const tenantEvaluated = root.children.reduce((a, c) => a + c.totals.evaluated, 0);
  assert.equal(tenantEvaluated, root.totals.evaluated);
});

test("?tenant=twh returns a tenant-level root", async () => {
  const res = await get("?measureId=audiogram&tenant=twh");
  assert.equal(res?.status, 200);
  const root = (await res!.json()) as Node;
  assert.equal(root.level, "tenant");
  assert.equal(root.id, "twh");
  assert.equal(root.totals.evaluated, 2);
});

test("non-GET → null (not handled here)", async () => {
  const res = await handleHierarchy(new Request("http://x/api/hierarchy/rollup", { method: "POST" }), env as never);
  assert.equal(res, null);
});

test("unrelated path → null", async () => {
  const res = await handleHierarchy(new Request("http://x/api/other", { method: "GET" }), env as never);
  assert.equal(res, null);
});

test("malformed from date → 400 (parity with /api/programs)", async () => {
  const res = await get("?from=not-a-date");
  assert.equal(res?.status, 400);
  const body = (await res!.json()) as { message: string };
  assert.match(body.message, /from must use YYYY-MM-DD/);
  assert.equal((await get("?to=2026-13-01"))?.status, 400, "overflow month rejected");
  assert.equal((await get("?from=2026-01-01&to=2026-12-31"))?.status, 200, "valid dates still 200");
});

test("unknown measureId → 200 with an empty All-Systems tree", async () => {
  const res = await get("?measureId=does-not-exist");
  assert.equal(res?.status, 200);
  const root = (await res!.json()) as { level: string; totals: { evaluated: number }; children: unknown[] };
  assert.equal(root.level, "all");
  assert.equal(root.totals.evaluated, 0);
  assert.equal(root.children.length, 0);
});
