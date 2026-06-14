/**
 * MCP tools + dispatch + audit test (#108) — each of the 13 tools over the real SQLite
 * stores, through callTool (so the role gate + per-call audit are exercised too).
 *   node --import tsx --test src/mcp/tools.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteMeasureStore } from "../stores/sqlite/measure-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { seedMeasureStore } from "../measure/measure-seed.ts";
import { MCP_TOOLS } from "./tools.ts";
import { callTool, type DispatchCtx } from "./dispatch.ts";
import type { JsonRecord } from "./tool-audit.ts";

const dbPath = join(tmpdir(), `workwell-mcptools-${crypto.randomUUID()}.sqlite`);
let db: import("@mieweb/cloud").CloudDatabase;
let events: SqliteCaseEventStore;
let deps: DispatchCtx["deps"];
let caseIdOverdue: string;
let runId: string;

// Minimal CQL so explain_rule has defines to extract.
const CQL_BY_ID: Record<string, string> = {
  audiogram: 'define "In Hearing Conservation Program": true\ndefine "Has Active Waiver": false\ndefine "Outcome Status": \'OVERDUE\'',
};

function ctx(role: string | null = null, enforce = false): DispatchCtx {
  return { deps, events, actor: "cm@workwell.dev", role, enforce };
}
async function call(name: string, args: JsonRecord, c: DispatchCtx = ctx()): Promise<{ payload: JsonRecord; isError: boolean }> {
  const res = await callTool(name, args, c);
  return { payload: JSON.parse(res.content[0]!.text) as JsonRecord, isError: res.isError };
}

before(async () => {
  db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  await migrateFloorSchema(db);
  const measureStore = new SqliteMeasureStore(db);
  await seedMeasureStore(measureStore, (id) => CQL_BY_ID[id] ?? "");
  events = new SqliteCaseEventStore(db);
  deps = {
    caseStore: new SqliteCaseStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    runStore: new SqliteRunStore(db),
    measureStore,
  };

  const run = await deps.runStore.createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  runId = run.id;
  await deps.runStore.finalizeRun(run.id, "COMPLETED");
  const c = await deps.caseStore.upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  caseIdOverdue = c!.id;
  await deps.caseStore.upsertFromOutcome({ runId, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: "2026-06-13", outcomeStatus: "MISSING_DATA" });
  await deps.caseStore.upsertFromOutcome({ runId, subjectId: "emp-008", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "EXCLUDED" });
  await deps.outcomeStore.recordOutcome({
    runId,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "OVERDUE",
    evidence: {
      expressionResults: [
        { define: "Has Active Waiver", result: false },
        { define: "Most Recent Audiogram Date", result: "2025-04-19T00:00:00.000Z" },
        { define: "Days Since Last Audiogram", result: 420 },
        { define: "Outcome Status", result: "OVERDUE" },
      ],
    },
  });
  await deps.outcomeStore.recordOutcome({ runId, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: "2026-06-13", status: "MISSING_DATA", evidence: {} });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("MCP_TOOLS registers all 13 tools", () => {
  assert.equal(MCP_TOOLS.length, 13);
  const names = MCP_TOOLS.map((t) => t.name);
  for (const n of ["get_case", "list_cases", "get_run_summary", "list_measures", "get_measure_version", "list_runs", "explain_outcome", "get_employee", "check_compliance", "list_noncompliant", "explain_rule", "get_measure_traceability", "list_data_quality_gaps"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
});

test("get_case returns detail + evidence_payload + why_flagged", async () => {
  const { payload, isError } = await call("get_case", { caseId: caseIdOverdue });
  assert.equal(isError, false);
  assert.equal(payload.caseId, caseIdOverdue);
  assert.ok(payload.evidence_payload);
  assert.ok(payload.why_flagged);
});

test("get_case rejects a non-UUID caseId (INVALID_ARGUMENT, not isError)", async () => {
  const { payload, isError } = await call("get_case", { caseId: "not-a-uuid" });
  assert.equal(isError, false);
  assert.equal(payload.code, "INVALID_ARGUMENT");
});

test("get_case unknown UUID → tool error", async () => {
  const { isError } = await call("get_case", { caseId: crypto.randomUUID() });
  assert.equal(isError, true);
});

test("list_cases returns snake_case rows; status filter scopes", async () => {
  const { payload } = await call("list_cases", { status: "open" });
  const results = payload.results as JsonRecord[];
  assert.ok(results.length >= 2);
  assert.ok("case_id" in results[0]! && "employee_name" in results[0]! && "current_outcome_status" in results[0]!);
});

test("list_cases with an unresolved measure filter errors (no silent leak of all cases)", async () => {
  const { payload } = await call("list_cases", { measureName: "No Such Measure" });
  assert.equal(payload.code, "MEASURE_NOT_FOUND");
  const byId = await call("list_cases", { measureId: "not-a-real-slug" });
  assert.equal(byId.payload.code, "MEASURE_NOT_FOUND");
});

test("list_noncompliant with an unresolved measure filter errors (no silent leak)", async () => {
  const { payload } = await call("list_noncompliant", { measureName: "No Such Measure" });
  assert.equal(payload.code, "MEASURE_NOT_FOUND");
});

test("get_run_summary by id, and latest when omitted", async () => {
  const byId = await call("get_run_summary", { runId });
  assert.equal((byId.payload as JsonRecord).run_id, runId);
  const latest = await call("get_run_summary", {});
  assert.equal((latest.payload as JsonRecord).run_id, runId);
});

test("get_run_summary rejects a non-UUID runId", async () => {
  const { payload } = await call("get_run_summary", { runId: "nope" });
  assert.equal(payload.code, "INVALID_ARGUMENT");
});

test("list_measures defaults to Active and filters by status", async () => {
  const active = await call("list_measures", {});
  const rows = (active.payload as JsonRecord).results as JsonRecord[];
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => String(r.status).toLowerCase() === "active"));
  const draft = await call("list_measures", { status: "Draft" });
  assert.ok(((draft.payload as JsonRecord).results as JsonRecord[]).every((r) => String(r.status) === "Draft"));
});

test("get_measure_version by id and by name; not found → error", async () => {
  const byId = await call("get_measure_version", { measureId: "audiogram" });
  assert.equal((byId.payload as JsonRecord).measureId, "audiogram");
  assert.ok((byId.payload as JsonRecord).specJson);
  const byName = await call("get_measure_version", { measureName: (byId.payload as JsonRecord).measureName as string });
  assert.equal((byName.payload as JsonRecord).measureId, "audiogram");
  const missing = await call("get_measure_version", { measureId: "nope" });
  assert.equal(missing.isError, true);
});

test("list_runs returns runs with outcome_counts + compliance_rate", async () => {
  const { payload } = await call("list_runs", { measureId: "audiogram" });
  const rows = (payload as JsonRecord).results as JsonRecord[];
  assert.ok(rows.length >= 1);
  assert.equal(rows[0]!.run_id, runId);
  assert.ok((rows[0]!.outcome_counts as JsonRecord).OVERDUE != null);
});

test("list_runs validates limit", async () => {
  assert.equal((await call("list_runs", { limit: "abc" })).payload.code, "INVALID_ARGUMENT");
  assert.equal((await call("list_runs", { limit: 0 })).payload.code, "INVALID_ARGUMENT");
});

test("explain_outcome produces a deterministic sentence", async () => {
  const { payload } = await call("explain_outcome", { caseId: caseIdOverdue });
  assert.match(payload.explanation as string, /was flagged as OVERDUE/);
  assert.ok(payload.why_flagged);
});

test("get_employee returns profile + latest outcomes; unknown → EMPLOYEE_NOT_FOUND", async () => {
  const { payload } = await call("get_employee", { employeeExternalId: "emp-006" });
  assert.equal(payload.employeeExternalId, "emp-006");
  assert.ok(Array.isArray(payload.latestOutcomes));
  assert.ok((payload.latestOutcomes as unknown[]).length >= 1);
  const missing = await call("get_employee", { employeeExternalId: "emp-999" });
  assert.equal(missing.payload.code, "EMPLOYEE_NOT_FOUND");
});

test("check_compliance returns latest outcome + open caseId; NO_OUTCOME when none; bad mode", async () => {
  const got = await call("check_compliance", { employeeExternalId: "emp-006", measureName: "Annual Audiogram Completed" });
  assert.equal(got.payload.status, "OVERDUE");
  assert.equal(got.payload.decisionAvailable, true);
  assert.equal(got.payload.complianceDecisionSource, "cql_outcome");
  assert.equal(got.payload.caseId, caseIdOverdue);
  const none = await call("check_compliance", { employeeExternalId: "emp-010", measureName: "Annual Audiogram Completed" });
  assert.equal(none.payload.status, "NO_OUTCOME");
  assert.equal(none.payload.decisionAvailable, false);
  const bad = await call("check_compliance", { employeeExternalId: "emp-006", measureName: "x", mode: "bogus" });
  assert.equal(bad.payload.code, "INVALID_ARGUMENT");
});

test("list_noncompliant lists open non-compliant cases; bad status rejected", async () => {
  const { payload } = await call("list_noncompliant", {});
  const rows = (payload as JsonRecord).results as JsonRecord[];
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => ["DUE_SOON", "OVERDUE", "MISSING_DATA"].includes(String(r.outcomeStatus))));
  const bad = await call("list_noncompliant", { status: "COMPLIANT" });
  assert.equal(bad.payload.code, "INVALID_ARGUMENT");
});

test("explain_rule extracts CQL defines from the measure", async () => {
  const { payload } = await call("explain_rule", { measureId: "audiogram" });
  assert.deepEqual(payload.cqlDefines, ["In Hearing Conservation Program", "Has Active Waiver", "Outcome Status"]);
  assert.equal(payload.source, "deterministic_metadata");
});

test("traceability + data-quality tools return NOT_IMPLEMENTED (faithful, not faked)", async () => {
  assert.equal((await call("get_measure_traceability", { measureId: "audiogram" })).payload.code, "NOT_IMPLEMENTED");
  assert.equal((await call("list_data_quality_gaps", { measureId: "audiogram" })).payload.code, "NOT_IMPLEMENTED");
});

test("every tool call writes an MCP_TOOL_CALLED audit with sanitized args + hash", async () => {
  await call("get_employee", { employeeExternalId: "emp-006" });
  const audits = await events.listAuditEvents();
  const mcp = audits.filter((a) => a.eventType === "MCP_TOOL_CALLED");
  assert.ok(mcp.length > 0);
  const last = mcp[mcp.length - 1]!.payload as JsonRecord;
  assert.ok(last.toolName);
  assert.ok(last.sanitizedArguments);
  assert.match(String(last.argumentHash), /^[0-9a-f]{64}$/);
  assert.ok("sensitivityLabel" in last);
});

test("role gate: MCP_CLIENT is denied (audited); CASE_MANAGER is allowed", async () => {
  const denied = await call("get_case", { caseId: caseIdOverdue }, ctx("ROLE_MCP_CLIENT", true));
  assert.equal(denied.payload.code, "ACCESS_DENIED");
  const allowed = await call("get_case", { caseId: caseIdOverdue }, ctx("ROLE_CASE_MANAGER", true));
  assert.equal(allowed.isError, false);
  assert.equal(allowed.payload.caseId, caseIdOverdue);
  // the denial wrote a failure audit
  const audits = await events.listAuditEvents();
  assert.ok(audits.some((a) => a.eventType === "MCP_TOOL_CALLED" && (a.payload as JsonRecord).success === false));
});
