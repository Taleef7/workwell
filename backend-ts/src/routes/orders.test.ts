/**
 * Orders route (#77 E7): seed an audiogram population run + outcomes (OVERDUE + COMPLIANT),
 * then assert GET /api/orders/proposals returns proposals for at-risk subjects only.
 *   node --import tsx --test src/routes/orders.test.ts
 *
 * Harness mirrors hierarchy.test.ts exactly: real SQLite D1 + SqliteRunStore/OutcomeStore.
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
import { handleOrders } from "./orders.ts";

const dbPath = join(tmpdir(), `workwell-orders-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (qs = "") => handleOrders(new Request(`http://x/api/orders/proposals${qs}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  // Seed a population (ALL_PROGRAMS) run with one at-risk and one compliant subject.
  // Finalize to COMPLETED so the terminal-run filter includes it.
  const run = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    scopeId: undefined,
    triggeredBy: "test",
    requestedScope: {},
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-007", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await runStore.finalizeRun(run.id, "COMPLETED");
});

after(() => {
  try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
});

test("returns domain proposals for at-risk outcomes (default format)", async () => {
  const res = await get("");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { proposed: Array<{ subjectId: string }>; suppressed: Array<{ subjectId: string }> };
  assert.ok(Array.isArray(body.proposed));
  // emp-006 is OVERDUE → should appear in proposed (unless simulated standing-order suppresses; hash-check)
  // emp-007 is COMPLIANT → must not appear in proposed or suppressed
  const allSubjects = [...body.proposed, ...body.suppressed].map((p) => p.subjectId);
  assert.ok(!body.proposed.some((p) => p.subjectId === "emp-007"), "COMPLIANT subject must not be proposed");
  assert.ok(!body.suppressed.some((p) => p.subjectId === "emp-007"), "COMPLIANT subject must not be suppressed");
  // emp-006 must appear in proposed OR suppressed (simulated may suppress ~1 in 5)
  assert.ok(allSubjects.includes("emp-006"), "at-risk subject must appear in proposed or suppressed");
});

test("format=fhir returns a ServiceRequest Bundle", async () => {
  const res = await get("?format=fhir");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { resourceType: string; type: string };
  assert.equal(body.resourceType, "Bundle");
  assert.equal(body.type, "collection");
});

test("400 on malformed from date", async () => {
  const res = await get("?from=2026-13-99");
  assert.equal(res!.status, 400);
});

test("falls through (null) on non-match path", async () => {
  assert.equal(await handleOrders(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

test("falls through (null) on non-GET method", async () => {
  assert.equal(await handleOrders(new Request("http://x/api/orders/proposals", { method: "POST" }), env as never), null);
});

test("measureId filter: unknown Active measure returns empty lists", async () => {
  const res = await get("?measureId=does-not-exist");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { proposed: unknown[]; suppressed: unknown[] };
  assert.equal(body.proposed.length, 0);
  assert.equal(body.suppressed.length, 0);
});

test("subjectId filter narrows to that subject", async () => {
  // emp-006 (OVERDUE) → present in proposed or suppressed; emp-007 (COMPLIANT) → empty
  const r6 = await get("?subjectId=emp-006");
  const b6 = await r6!.json() as { proposed: Array<{ subjectId: string }>; suppressed: Array<{ subjectId: string }> };
  const subjects6 = [...b6.proposed, ...b6.suppressed].map((p) => p.subjectId);
  assert.ok(subjects6.includes("emp-006"));
  assert.ok(subjects6.every((s) => s === "emp-006"), "only emp-006 should be present");

  const r7 = await get("?subjectId=emp-007");
  const b7 = await r7!.json() as { proposed: unknown[]; suppressed: unknown[] };
  assert.equal(b7.proposed.length, 0); // COMPLIANT → no proposal
  assert.equal(b7.suppressed.length, 0);
});

test("RUNNING run is excluded from proposals (only terminal runs contribute)", async () => {
  // Seed a second ALL_PROGRAMS run left RUNNING (not finalized) with a newer started_at.
  // Its outcomes must NOT appear in proposals — only the COMPLETED run's outcomes should.
  const db = (env as { DB: unknown }).DB;
  const runStore = new SqliteRunStore(db as never);
  const outcomes = new SqliteOutcomeStore(db as never);
  // Ensure this run has a later started_at than the COMPLETED run seeded in before().
  await new Promise((r) => setTimeout(r, 5));
  const runningRun = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    scopeId: undefined,
    triggeredBy: "test-running",
    requestedScope: {},
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  // Mark it RUNNING (in-flight — never finalized)
  await runStore.markRunning(runningRun.id);
  // Give this RUNNING run an OVERDUE outcome for a unique new subject
  await outcomes.recordOutcome({ runId: runningRun.id, subjectId: "emp-running-only", measureId: "audiogram", status: "OVERDUE", evidence: {} });

  const res = await get("");
  const body = await res!.json() as { proposed: Array<{ subjectId: string }>; suppressed: Array<{ subjectId: string }> };
  const allSubjects = [...body.proposed, ...body.suppressed].map((p) => p.subjectId);
  assert.ok(
    !allSubjects.includes("emp-running-only"),
    "subject from RUNNING run must not appear in proposals (in-flight run excluded)",
  );
  // emp-006 from the COMPLETED run must still appear
  assert.ok(allSubjects.includes("emp-006"), "subject from COMPLETED run still appears");
});
