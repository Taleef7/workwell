/**
 * Exports route test (#108): seed a run + outcomes + case + audit, then assert the CSV
 * exports carry the right headers/rows and the format gate. node --import tsx --test src/routes/exports.test.ts
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
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handleExports } from "./exports.ts";

const dbPath = join(tmpdir(), `workwell-exports-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let runId: string;

const get = (path: string) => handleExports(new Request(`http://x${path}`, { method: "GET" }), env as never);
const text = async (path: string) => (await get(path).then((r) => r!.text())).split("\r\n");

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
  const oc = new SqliteOutcomeStore(db);
  await oc.recordOutcome({
    runId,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "OVERDUE",
    evidence: { expressionResults: [{ define: "Most Recent Audiogram Date", result: "2025-04-19" }, { define: "Days Since Last Audiogram", result: 420 }] },
  });
  await new SqliteCaseStore(db).upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  await new SqliteCaseEventStore(db).appendAudit({
    eventType: "CASE_ASSIGNED",
    entityType: "case",
    entityId: "c1",
    actor: "cm@workwell.dev",
    refRunId: runId,
    refCaseId: "c1",
    refMeasureVersionId: "audiogram-v1.0",
    payload: { subjectId: "emp-006", assignee: "cm@workwell.dev" },
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/exports/runs?format=csv → run summary CSV", async () => {
  const res = await get("/api/exports/runs?format=csv");
  assert.equal(res?.status, 200);
  assert.equal(res!.headers.get("content-type"), "text/csv");
  assert.match(res!.headers.get("content-disposition") ?? "", /attachment; filename="runs\.csv"/);
  const lines = (await res!.text()).split("\r\n");
  assert.match(lines[0]!, /^runId,measureName,measureVersion,.*passRate,dataFreshAsOf$/);
  assert.ok(lines.some((l) => l.startsWith(runId)), "the run is a row");
  assert.ok(lines.some((l) => l.includes("Audiogram")));
});

test("GET /api/exports/outcomes?runId carries derived why_flagged columns", async () => {
  const lines = await text(`/api/exports/outcomes?format=csv&runId=${runId}`);
  assert.match(lines[0]!, /^outcomeId,runId,employeeExternalId,employeeName,.*waiverStatus,evaluatedAt$/);
  const row = lines.find((l) => l.includes("emp-006"))!;
  assert.ok(row, "the outcome row is present");
  // OVERDUE audiogram: lastExamDate 2025-04-19, window 365, daysOverdue 420-365=55, waiver none
  assert.ok(row.includes("2025-04-19"));
  assert.ok(row.includes("55"));
  assert.ok(row.includes("Omar Siddiq"));
});

test("GET /api/exports/cases carries the case + latestOutreachDeliveryStatus column", async () => {
  const lines = await text("/api/exports/cases?format=csv&status=open");
  assert.match(lines[0]!, /^caseId,employeeExternalId,.*closedAt,latestOutreachDeliveryStatus$/);
  assert.ok(lines.some((l) => l.includes("Omar Siddiq") && l.includes("OVERDUE")));
});

test("GET /api/audit-events/export lists the audit ledger", async () => {
  const lines = await text("/api/audit-events/export?format=csv");
  assert.equal(lines[0], "timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail");
  assert.ok(lines.some((l) => l.includes("CASE_ASSIGNED") && l.includes("cm@workwell.dev")));
});

test("non-csv format → 400 with the Java parity message", async () => {
  const res = await get("/api/exports/runs?format=json");
  assert.equal(res?.status, 400);
  assert.match(await res!.text(), /Unsupported format\. Use format=csv\./);
});
