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
let latestRunId: string;
let caseId: string;

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
  const caseRec = await new SqliteCaseStore(db).upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  caseId = caseRec!.id;
  const events = new SqliteCaseEventStore(db);
  // A case-action audit WITHOUT subjectId in the payload — employeeId must come from the case.
  await events.appendAudit({
    eventType: "CASE_ESCALATED",
    entityType: "case",
    entityId: caseId,
    actor: "cm@workwell.dev",
    refRunId: runId,
    refCaseId: caseId,
    refMeasureVersionId: "audiogram-v1.0",
    payload: { priority: "HIGH", reason: "Manual escalation requested" },
  });

  // A later run (no outcomes) so the default outcomes export must resolve the LATEST run.
  await new Promise((r) => setTimeout(r, 8));
  const later = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "hazwoper",
    triggeredBy: "test",
    requestedScope: { measureId: "hazwoper" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  latestRunId = later.id;
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

test("GET /api/audit-events/export lists the ledger; employeeId derived from the referenced case", async () => {
  const lines = await text("/api/audit-events/export?format=csv");
  assert.equal(lines[0], "timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail");
  const row = lines.find((l) => l.includes("CASE_ESCALATED"))!;
  assert.ok(row, "the escalation audit row is present");
  // The payload has no subjectId — employeeId column must come from the case's employee (emp-006).
  const cols = row.split(",");
  assert.equal(cols[5], "emp-006", "employeeId resolved via ref_case_id → case.employee_id");
  assert.equal(cols[6], "cm@workwell.dev", "actor");
});

test("default outcomes export (no runId) resolves the LATEST run", async () => {
  // The latest run (hazwoper) has no outcomes → just the header row (not the older audiogram run's rows).
  const lines = (await text("/api/exports/outcomes?format=csv")).filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "only the header — the latest run has no outcomes");
  assert.ok(!lines.some((l) => l.includes("emp-006")), "older run's outcomes are NOT mixed in");
  // explicit older runId still works
  assert.ok((await text(`/api/exports/outcomes?format=csv&runId=${runId}`)).some((l) => l.includes("emp-006")));
});

test("cases export honors caseIds (selected set) and the site filter", async () => {
  // caseIds → exactly the selected case(s); a non-matching id → header only.
  const sel = (await text(`/api/exports/cases?format=csv&caseIds=${caseId}`)).filter((l) => l.length > 0);
  assert.equal(sel.length, 2, "header + the one selected case");
  assert.ok(sel.some((l) => l.startsWith(caseId)));
  const none = (await text(`/api/exports/cases?format=csv&caseIds=${crypto.randomUUID()}`)).filter((l) => l.length > 0);
  assert.equal(none.length, 1, "no case matched → header only");
  // site filter: Plant A keeps emp-006; HQ drops it
  assert.ok((await text("/api/exports/cases?format=csv&site=Plant%20A")).some((l) => l.includes("Omar Siddiq")));
  assert.ok(!(await text("/api/exports/cases?format=csv&site=HQ")).some((l) => l.includes("Omar Siddiq")));
});

test("non-csv format → 400 with the Java parity message", async () => {
  const res = await get("/api/exports/runs?format=json");
  assert.equal(res?.status, 400);
  assert.match(await res!.text(), /Unsupported format\. Use format=csv\./);
});
