/**
 * Auditor route test (#108): seed a run + outcomes + ledger and a seeded measure, then assert the
 * run + measure-version packets carry the right sections, write the AUDIT_PACKET_GENERATED ledger
 * row + export record, the format gate (json/html/400), and 404 for unknown ids.
 * node --import tsx --test src/routes/auditor.test.ts
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
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { ensureMeasureStore } from "./measures.ts";
import { handleAuditor } from "./auditor.ts";

const dbPath = join(tmpdir(), `workwell-auditor-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let runId: string;
let versionId: string;

const get = (path: string) => handleAuditor(new Request(`http://x${path}`, { method: "GET" }), env as never, "auditor@workwell.dev");

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };

  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  runId = run.id;
  await new SqliteRunStore(db).appendLog(runId, "INFO", "run started");
  await new SqliteOutcomeStore(db).recordOutcome({
    runId,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "OVERDUE",
    evidence: { expressionResults: [{ define: "Days Since Last Audiogram", result: 420 }] },
  });
  const events = new SqliteCaseEventStore(db);
  await events.appendAudit({
    eventType: "RUN_COMPLETED",
    entityType: "run",
    entityId: runId,
    actor: "cm@workwell.dev",
    refRunId: runId,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: { status: "COMPLETED" },
  });

  // Seed the measure catalog, then record an approval audit against the audiogram version.
  const measures = await ensureMeasureStore(env as never);
  versionId = (await measures.getLatest("audiogram"))!.versionId;
  await events.appendAudit({
    eventType: "MEASURE_APPROVED",
    entityType: "measure_version",
    entityId: versionId,
    actor: "approver@workwell.dev",
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: versionId,
    payload: { version: "v1.0" },
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/auditor/runs/:id/packet?format=json → RUN packet + headers", async () => {
  const res = await get(`/api/auditor/runs/${runId}/packet?format=json`);
  assert.equal(res?.status, 200);
  assert.equal(res!.headers.get("content-type"), "application/json");
  assert.match(res!.headers.get("content-disposition") ?? "", new RegExp(`attachment; filename="workwell-run-packet-${runId}\\.json"`));
  const p = JSON.parse(await res!.text());
  assert.equal(p.packetType, "RUN");
  assert.equal(p.generatedBy, "auditor@workwell.dev");
  assert.equal(p.run.runId, runId);
  assert.equal(p.summary.totalEvaluated, 1);
  assert.equal(p.summary.nonCompliant, 1);
  assert.equal(p.outcomes.length, 1);
  assert.ok(p.runLogs.some((l: { message: string }) => l.message === "run started"));
  assert.ok(p.auditEvents.some((e: { eventType: string }) => e.eventType === "RUN_COMPLETED"));
  assert.ok(Array.isArray(p.disclaimers) && p.disclaimers.length === 3);
});

test("RUN packet writes the AUDIT_PACKET_GENERATED ledger row (hash + size)", async () => {
  await get(`/api/auditor/runs/${runId}/packet?format=json`);
  const ledger = await new SqliteCaseEventStore((env as { DB: never }).DB).auditEventsByRun(runId);
  const gen = ledger.find((e) => e.eventType === "AUDIT_PACKET_GENERATED");
  assert.ok(gen, "AUDIT_PACKET_GENERATED present on the run ledger");
  assert.equal(gen!.payload.packetType, "RUN");
  assert.match(String(gen!.payload.payloadHash), /^sha256:[0-9a-f]{64}$/);
  assert.ok(Number(gen!.payload.sizeBytes) > 0);
});

test("RUN packet format=html → HTML render of the same content", async () => {
  const res = await get(`/api/auditor/runs/${runId}/packet?format=html`);
  assert.equal(res?.status, 200);
  assert.equal(res!.headers.get("content-type"), "text/html");
  const html = await res!.text();
  assert.match(html, /<h1>WorkWell Audit Packet: RUN<\/h1>/);
  assert.match(html, /Disclaimers/);
});

test("GET /api/auditor/measure-versions/:id/packet → MEASURE_VERSION packet", async () => {
  const res = await get(`/api/auditor/measure-versions/${versionId}/packet?format=json`);
  assert.equal(res?.status, 200);
  const p = JSON.parse(await res!.text());
  assert.equal(p.packetType, "MEASURE_VERSION");
  assert.equal(p.measure.measureVersionId, versionId);
  assert.equal(p.measure.measureId, "audiogram");
  assert.match(String(p.cql.hash), /^[0-9a-f]{64}$/, "audiogram carries CQL → a content hash");
  assert.ok(p.traceability && Array.isArray(p.traceability.rows), "traceability section present");
  assert.ok(p.dataReadiness && typeof p.dataReadiness.overallStatus === "string", "data-readiness section present");
  assert.ok(p.approvalHistory.some((e: { eventType: string }) => e.eventType === "MEASURE_APPROVED"), "approval history filtered");
  assert.ok(Array.isArray(p.disclaimers) && p.disclaimers.length === 4);
});

test("format gate + not-found", async () => {
  assert.equal((await get(`/api/auditor/runs/${runId}/packet?format=xml`))?.status, 400);
  assert.equal((await get(`/api/auditor/runs/${crypto.randomUUID()}/packet?format=json`))?.status, 404);
  assert.equal((await get(`/api/auditor/measure-versions/${crypto.randomUUID()}/packet`))?.status, 404);
});

test("non-auditor path → null (not owned by this handler)", async () => {
  assert.equal(await get("/api/runs"), null);
});
