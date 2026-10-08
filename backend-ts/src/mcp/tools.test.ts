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
  // The authored subset cms125's catalog record carries — NOT what runs once CMS's artifact is routed (#769).
  cms125: 'define "Initial Population": true\ndefine "Numerator": false',
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
  events = new SqliteCaseEventStore(db);
  await seedMeasureStore(measureStore, (id) => CQL_BY_ID[id] ?? "", events);
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

test("get_case unknown UUID → CASE_NOT_FOUND safe payload", async () => {
  const { payload, isError } = await call("get_case", { caseId: crypto.randomUUID() });
  assert.equal(isError, false);
  assert.equal(payload.code, "CASE_NOT_FOUND");
});

test("explain_outcome unknown UUID → CASE_NOT_FOUND safe payload", async () => {
  const { payload, isError } = await call("explain_outcome", { caseId: crypto.randomUUID() });
  assert.equal(isError, false);
  assert.deepEqual(payload, { error: true, code: "CASE_NOT_FOUND", message: "Case not found" });
});

test("list_cases returns snake_case rows; status filter scopes", async () => {
  const { payload } = await call("list_cases", { status: "open" });
  const results = payload.results as JsonRecord[];
  assert.ok(results.length >= 2);
  assert.ok("case_id" in results[0]! && "employee_name" in results[0]! && "current_outcome_status" in results[0]!);
});

test("list_cases status=staff_closed returns the closures a PERSON made, with all three live fields", async () => {
  // A subject of this test's own, so closing it cannot change what the other tests see.
  const closed = await deps.caseStore.upsertFromOutcome({
    runId, subjectId: "emp-042", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
  });
  await deps.caseStore.patchCase(closed!.id, {
    status: "CLOSED", closedAt: "2026-06-14T00:00:00Z", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.org",
  });

  const { payload } = await call("list_cases", { status: "staff_closed", period: "all" });
  const rows = payload.results as JsonRecord[];
  const row = rows.find((r) => r.employee_id === "emp-042");
  assert.ok(row, "the case a person closed is on the staff_closed list");
  assert.equal(row!.closure, "STAFF");
  assert.equal(row!.closed_by, "nurse@example.org");
  assert.equal(row!.closed_reason, "MANUAL_RESOLVE");

  // All THREE, together. `MCP.md` promises the trio because the canonical bucket alone cannot
  // distinguish an out-of-population patient (canonical MISSING_DATA, display OUT_OF_POPULATION) from
  // a real gap — and `live_display_status` was documented while the tool emitted only the other two,
  // which is a contract a reader would have believed.
  for (const field of ["live_state", "live_outcome_status", "live_display_status"]) {
    assert.ok(field in row!, `a staff_closed row carries ${field}`);
  }
  // `current_outcome_status` is the FROZEN value and keeps its own meaning beside them.
  assert.equal(row!.current_outcome_status, "OVERDUE");

  // And every row on every filter says which kind of closure it is, so a client never has to infer
  // it from `status` — which cannot say it (a manual close writes CLOSED, a rerun-verified one
  // RESOLVED, and the nightly run's auto-resolve writes RESOLVED too).
  const open = await call("list_cases", { status: "open" });
  assert.ok((open.payload.results as JsonRecord[]).every((r) => r.closure === "NONE"));
  assert.ok(!(open.payload.results as JsonRecord[]).some((r) => r.employee_id === "emp-042"), "and it is off the open list");
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

test("get_measure_traceability returns the matrix; missing ref + unknown measure error", async () => {
  const { payload } = await call("get_measure_traceability", { measureId: "audiogram" });
  assert.equal(payload.measureId, "audiogram");
  assert.ok(Array.isArray(payload.rows) && (payload.rows as unknown[]).length > 0);
  assert.ok(Array.isArray(payload.gaps));
  assert.equal((await call("get_measure_traceability", {})).payload.code, "INVALID_ARGUMENT");
  assert.equal((await call("get_measure_traceability", { measureId: "nope" })).payload.code, "MEASURE_NOT_FOUND");
});

test("list_data_quality_gaps returns the readiness summary; missing ref + unknown measure error", async () => {
  const { payload } = await call("list_data_quality_gaps", { measureId: "audiogram" });
  assert.equal(payload.measureId, "audiogram");
  assert.ok(typeof payload.overallStatus === "string");
  assert.ok(Array.isArray(payload.elementReadiness) && (payload.elementReadiness as unknown[]).length > 0);
  assert.ok(Array.isArray(payload.blockers) && Array.isArray(payload.warnings));
  assert.equal((await call("list_data_quality_gaps", {})).payload.code, "INVALID_ARGUMENT");
  assert.equal((await call("list_data_quality_gaps", { measureId: "nope" })).payload.code, "MEASURE_NOT_FOUND");
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

test("ADR-046: explain_outcome does NOT assert a recency finding for a value-based measure", async () => {
  // A routed cms122 outcome has no recency criterion — `why_flagged` carries no `last_exam_date` and no
  // `days_overdue`, because the matchers correctly find nothing in official population evidence. The
  // unconditional version told an MCP client "their last qualifying exam was unknown date (unknown days
  // ago), which exceeds the 365-day compliance window", where the 365 came from the AUTHORED binding for
  // a measure now scored by CMS's artifact (review, #357). Asserted to an external client, labelled
  // deterministic, with no human in the loop.
  const { buildOutcomeExplanation } = await import("./tools.ts");
  const official = buildOutcomeExplanation("Jane Doe", "OVERDUE", "Diabetes: HbA1c Poor Control", {
    why_flagged: { role_eligible: true, site_eligible: true, waiver_status: "NONE" },
    expressionResults: [
      { define: "official:initial-population", result: true },
      { define: "official:numerator", result: true },
    ],
  });
  assert.ok(!official.includes("last qualifying exam"), "no recency claim without recency evidence");
  assert.ok(!official.includes("compliance window"), "no window claim for a value-based measure");
  assert.match(official, /Official population membership: initial-population=true, numerator=true/);
  assert.match(official, /was flagged as OVERDUE/);
});

test("ADR-074: explain_outcome names each rate of a multi-rate measure readably, and single-rate text is unchanged", async () => {
  const { buildOutcomeExplanation } = await import("./tools.ts");
  const text = buildOutcomeExplanation("Pat One", "OVERDUE", "SUD Treatment", {
    why_flagged: { role_eligible: true, site_eligible: true, waiver_status: "NONE" },
    expressionResults: [
      { define: "official:Initiation:numerator", result: true },
      { define: "official:Engagement:numerator", result: false },
    ],
  });
  assert.match(text, /Official population membership: Initiation · numerator=true, Engagement · numerator=false/);
});

test("explain_outcome never calls a WorkWell translation's membership official; it names the translation", async () => {
  const { buildOutcomeExplanation } = await import("./tools.ts");
  const expressionResults = [
    { define: "official:Initiation:numerator", result: true },
    { define: "official:Engagement:numerator", result: false },
  ];
  const text = buildOutcomeExplanation("Pat One", "OVERDUE", "SUD Treatment", {
    why_flagged: { role_eligible: true, site_eligible: true, waiver_status: "NONE" },
    expressionResults,
    official: { kind: "derived", label: "WorkWell translation of CMS137v15" },
  });
  assert.match(text, /Population membership \(WorkWell translation of CMS137v15\): Initiation · numerator=true, Engagement · numerator=false/);
  assert.doesNotMatch(text, /Official/);
  const unlabelled = buildOutcomeExplanation("Pat One", "OVERDUE", "SUD Treatment", { expressionResults, official: { kind: "derived" } });
  assert.match(unlabelled, /Population membership \(a WorkWell translation\):/, "a missing label still never reads as official");
  const cms = buildOutcomeExplanation("Pat One", "OVERDUE", "SUD Treatment", { expressionResults, official: { ecqmId: "137FHIR" } });
  assert.match(cms, /Official population membership: Initiation/, "CMS-scored text is unchanged");
});

test("ADR-046: a recency measure still gets its recency sentence", async () => {
  const { buildOutcomeExplanation } = await import("./tools.ts");
  const authored = buildOutcomeExplanation("Al Smith", "OVERDUE", "Audiogram", {
    why_flagged: { last_exam_date: "2025-03-10", days_overdue: 55, compliance_window_days: 365 },
  });
  assert.match(authored, /last qualifying exam was 2025-03-10 \(55 days ago\), which exceeds the 365-day/);
  assert.ok(!authored.includes("Official population membership"), "authored outcomes have no official block");
});

// #491 — the finalized-run rule (ADR-061's FINAL rule, applied to the MCP surface). An outcome row
// exists as soon as the evaluation loop writes it — BEFORE its run reaches a terminal status — so a
// newest-row read with no run-status check serves a mid-run partial result as the compliance answer.
// Dedicated subject (emp-011) + dedicated runs so nothing leaks into the shared fixture above.
test("#491 check_compliance never serves a mid-run row over an older finalized one", async () => {
  const done = await deps.runStore.createRun({
    scopeType: "EMPLOYEE",
    scopeId: "emp-011",
    triggeredBy: "test",
    requestedScope: { employeeId: "emp-011" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await deps.runStore.finalizeRun(done.id, "COMPLETED");
  await deps.outcomeStore.recordOutcome({
    runId: done.id,
    subjectId: "emp-011",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "OVERDUE",
    evidence: { expressionResults: [] },
    evaluatedAt: "2026-06-13T00:00:00.000Z",
  });
  // A newer row from a run that is still RUNNING — not an answer yet.
  const running = await deps.runStore.createRun({
    scopeType: "EMPLOYEE",
    scopeId: "emp-011",
    triggeredBy: "test",
    requestedScope: { employeeId: "emp-011" },
    measurementPeriodStart: "2026-06-14T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-14T00:00:00.000Z",
  });
  await deps.outcomeStore.recordOutcome({
    runId: running.id,
    subjectId: "emp-011",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-14",
    status: "COMPLIANT",
    evidence: { expressionResults: [] },
    evaluatedAt: "2026-06-14T00:00:00.000Z",
  });
  const { payload } = await call("check_compliance", { employeeExternalId: "emp-011", measureName: "Annual Audiogram Completed" });
  assert.equal(payload.status, "OVERDUE", "the finalized run's outcome is the answer, not the mid-run row");
  assert.equal(payload.evaluationPeriod, "2026-06-13");
  assert.equal(payload.decisionAvailable, true);
});

test("#491 check_compliance with ONLY mid-run rows → NO_OUTCOME, and the message says finalized", async () => {
  const running = await deps.runStore.createRun({
    scopeType: "EMPLOYEE",
    scopeId: "emp-012",
    triggeredBy: "test",
    requestedScope: { employeeId: "emp-012" },
    measurementPeriodStart: "2026-06-14T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-14T00:00:00.000Z",
  });
  await deps.outcomeStore.recordOutcome({
    runId: running.id,
    subjectId: "emp-012",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-14",
    status: "COMPLIANT",
    evidence: { expressionResults: [] },
    evaluatedAt: "2026-06-14T00:00:00.000Z",
  });
  const { payload } = await call("check_compliance", { employeeExternalId: "emp-012", measureName: "Annual Audiogram Completed" });
  assert.equal(payload.status, "NO_OUTCOME");
  assert.equal(payload.decisionAvailable, false);
  assert.match(String(payload.message), /finalized/i, "the absence message must not read as 'no run ever covered this subject'");
});

test("#491 get_employee latestOutcomes excludes mid-run rows and dedups to one per measure", async () => {
  // emp-011 now has: audiogram OVERDUE (finalized) + audiogram COMPLIANT (mid-run, newer).
  const { payload } = await call("get_employee", { employeeExternalId: "emp-011" });
  const rows = payload.latestOutcomes as Array<{ measureName: string; status: string }>;
  // The registry display name (`MEASURES[id].name`), not the measure-store name resolveMeasure matches.
  const audiogram = rows.filter((r) => r.measureName === "Audiogram");
  assert.equal(audiogram.length, 1, "one row per measure");
  assert.equal(audiogram[0]!.status, "OVERDUE", "the finalized run's outcome, never the mid-run row");
});

test("#492 check_compliance with an unknown measure name is MEASURE_NOT_FOUND, not advice to wait", async () => {
  // The generic absence message ("wait for the current run to finalize") is actively misleading for a
  // measure that does not exist — an AI client would retry forever (review on #492). Same rule as
  // list_cases / list_noncompliant: an unresolved measure filter errors, never a lookalike answer.
  const { payload } = await call("check_compliance", { employeeExternalId: "emp-006", measureName: "No Such Measure" });
  assert.equal(payload.code, "MEASURE_NOT_FOUND");
});

test("#492 a case reshaped by a still-running run is not attached to the finalized answer (Codex P2)", async () => {
  // Finalized run: COMPLIANT (no open case). A still-running run then writes OVERDUE for the SAME
  // period and opens a case. The served status is the finalized COMPLIANT; attaching the case the
  // unfinished evaluation just opened would pair two runs' worldviews in one answer.
  const done = await deps.runStore.createRun({
    scopeType: "EMPLOYEE",
    scopeId: "emp-013",
    triggeredBy: "test",
    requestedScope: { employeeId: "emp-013" },
    measurementPeriodStart: "2026-06-15T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-15T00:00:00.000Z",
  });
  await deps.runStore.finalizeRun(done.id, "COMPLETED");
  await deps.outcomeStore.recordOutcome({
    runId: done.id,
    subjectId: "emp-013",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-15",
    status: "COMPLIANT",
    evidence: { expressionResults: [] },
    evaluatedAt: "2026-06-15T00:00:00.000Z",
  });
  const running = await deps.runStore.createRun({
    scopeType: "EMPLOYEE",
    scopeId: "emp-013",
    triggeredBy: "test",
    requestedScope: { employeeId: "emp-013" },
    measurementPeriodStart: "2026-06-15T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-15T00:00:00.000Z",
  });
  await deps.outcomeStore.recordOutcome({
    runId: running.id,
    subjectId: "emp-013",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-15",
    status: "OVERDUE",
    evidence: { expressionResults: [] },
    evaluatedAt: "2026-06-16T00:00:00.000Z",
  });
  await deps.caseStore.upsertFromOutcome({ runId: running.id, subjectId: "emp-013", measureId: "audiogram", evaluationPeriod: "2026-06-15", outcomeStatus: "OVERDUE" });
  const { payload } = await call("check_compliance", { employeeExternalId: "emp-013", measureName: "Annual Audiogram Completed" });
  assert.equal(payload.status, "COMPLIANT", "the finalized run's outcome");
  assert.equal(payload.caseId, null, "a case whose state reflects an unfinished run must not be attached");
});

test("#492 get_employee orders same-timestamp measures deterministically by measureId", async () => {
  // Same evaluated_at for several measures is the nightly ALL_PROGRAMS shape; without a tie-break the
  // top-5 cap depends on join order and can differ between the SQLite floor and the Pg ceiling.
  const done = await deps.runStore.createRun({
    scopeType: "EMPLOYEE",
    scopeId: "emp-014",
    triggeredBy: "test",
    requestedScope: { employeeId: "emp-014" },
    measurementPeriodStart: "2026-06-15T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-15T00:00:00.000Z",
  });
  await deps.runStore.finalizeRun(done.id, "COMPLETED");
  // hazwoper inserted FIRST: a stable sort with no tie-break preserves store order and fails this.
  for (const measureId of ["hazwoper", "audiogram"]) {
    await deps.outcomeStore.recordOutcome({
      runId: done.id,
      subjectId: "emp-014",
      measureId,
      evaluationPeriod: "2026-06-15",
      status: "COMPLIANT",
      evidence: { expressionResults: [] },
      evaluatedAt: "2026-06-15T00:00:00.000Z",
    });
  }
  const { payload } = await call("get_employee", { employeeExternalId: "emp-014" });
  const rows = payload.latestOutcomes as Array<{ measureName: string }>;
  assert.deepEqual(
    rows.map((r) => r.measureName),
    ["Audiogram", "HAZWOPER Surveillance"],
    "equal timestamps order by measureId",
  );
});

// ---- #769: versioned identity ------------------------------------------------------------------
//
// LOCKED §4.3: a QDM identity ("CMS125v14", the catalog's `policyRef`) is never paired with the version
// of the FHIR artifact that executes ("1.0.000"), which would read as "CMS125v14 version 1.0.000 ran".
// The executed version travels only inside `executed`/`logic`, beside its own eCQM id ("CMS125FHIR").

const CMS125_EVIDENCE = {
  official: { ecqmId: "125FHIR", version: "1.0.000", engine: "fqm-execution", artifactSha256: "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8" },
  expressionResults: [{ define: "official:numerator", result: false }],
};
const TRANSLATION_EVIDENCE = {
  official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1" },
  expressionResults: [{ define: "official:Initiation:numerator", result: false }],
};
const EXECUTED_VERSIONS = new Set(["1.0.000", "ww-2027.1"]);
const QDM_ID = /^CMS\d+v\d+$/;
/** "CMS125v14 1.0.000", "CMS125v14 v1.0.000", "CMS125v14@1.0.000" inside one string. */
const QDM_WITH_EXECUTED = /CMS\d+v\d+[\s:@,-]*v?(?:1\.0\.000|ww-2027\.1)/;

/**
 * Every place a response pairs a QDM id with an executed version: an object carrying `policyRef` (or a
 * QDM id under any key but `derivedFrom`, which is lineage inside a logic object) whose own fields hold
 * the executed version, or one string joining the two.
 */
function qdmPairings(node: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => qdmPairings(n, `${path}[${i}]`, out));
  } else if (node && typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>);
    const qdm = entries.filter(([k, v]) => typeof v === "string" && QDM_ID.test(v) && k !== "derivedFrom").map(([k]) => k);
    if ("policyRef" in (node as object) || qdm.length > 0) {
      for (const [k, v] of entries) {
        if (typeof v === "string" && EXECUTED_VERSIONS.has(v.replace(/^v/, ""))) out.push(`${path}.${k}=${v} beside ${qdm.join(",") || "policyRef"}`);
      }
    }
    for (const [k, v] of entries) qdmPairings(v, `${path}.${k}`, out);
  } else if (typeof node === "string" && QDM_WITH_EXECUTED.test(node)) {
    out.push(`${path}="${node}"`);
  }
  return out;
}

test("the QDM-pairing matcher fires on the shapes it exists to catch (not a vacuous guard)", () => {
  assert.ok(qdmPairings({ policyRef: "CMS125v14", version: "1.0.000" }).length > 0);
  assert.ok(qdmPairings({ policyRef: "CMS125v14", measureVersion: "v1.0.000" }).length > 0);
  assert.ok(qdmPairings({ results: [{ cmsId: "CMS137v15", version: "ww-2027.1" }] }).length > 0);
  assert.ok(qdmPairings({ label: "CMS125v14 1.0.000" }).length > 0);
  // Lineage inside a logic object, and the catalog record's own version, are not pairings.
  assert.deepEqual(qdmPairings({ policyRef: "CMS125v14", version: "v1.0", executed: { ecqmId: "CMS125FHIR", version: "1.0.000", derivedFrom: "CMS125v14" } }), []);
});

test("#769: no MCP response pairs policyRef (or any QDM id) with the executed version; case tools name the row's logic", async () => {
  const run = await deps.runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    requestedScope: {},
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await deps.runStore.finalizeRun(run.id, "COMPLETED");
  await deps.outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-020", measureId: "cms125", evaluationPeriod: "2026-06-13", status: "OVERDUE", evidence: CMS125_EVIDENCE });
  await deps.outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-021", measureId: "cms137", evaluationPeriod: "2026-06-13", status: "OVERDUE", evidence: TRANSLATION_EVIDENCE });
  const cmsCase = (await deps.caseStore.upsertFromOutcome({ runId: run.id, subjectId: "emp-020", measureId: "cms125", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" }))!;
  const translatedCase = (await deps.caseStore.upsertFromOutcome({ runId: run.id, subjectId: "emp-021", measureId: "cms137", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" }))!;

  const responses: Record<string, unknown> = {};
  const record = async (label: string, name: string, args: JsonRecord): Promise<JsonRecord> => {
    const { payload, isError } = await call(name, args);
    assert.equal(isError, false, `${label} answered`);
    responses[label] = payload;
    return payload;
  };

  // Case and outcome tools read the ROW's evidence, with no routing configured at all: what scored a
  // row does not depend on today's flags.
  const cmsLogic = { kind: "cms-artifact", ecqmId: "CMS125FHIR", version: "1.0.000", derivedFrom: "CMS125v14", status: "draft", statusNote: "posted for public comment Jan–Feb 2026" };
  const getCase = await record("get_case", "get_case", { caseId: cmsCase.id });
  assert.deepEqual(getCase.logic, cmsLogic);
  assert.equal(getCase.measureVersion, "1.0.000", "the artifact's version, never the authored 2.0.0");
  const translated = await record("get_case translation", "get_case", { caseId: translatedCase.id });
  assert.equal((translated.logic as JsonRecord).kind, "workwell-translation");
  assert.equal(translated.measureVersion, "ww-2027.1");
  assert.ok(!("ecqmId" in (translated.logic as JsonRecord)), "a translation never carries a CMS eCQM id");

  const listed = ((await record("list_cases", "list_cases", { status: "open", measureId: "cms137" })).results as JsonRecord[])
    .find((r) => r.case_id === translatedCase.id)!;
  assert.equal(listed.measure_version, "ww-2027.1");
  assert.equal((listed.logic as JsonRecord).label, "WorkWell translation of CMS137v15");

  const noncompliant = ((await record("list_noncompliant", "list_noncompliant", { measureName: "Breast Cancer Screening" })).results as JsonRecord[])
    .find((r) => r.caseId === cmsCase.id)!;
  assert.equal(noncompliant.measureVersion, "1.0.000");
  assert.deepEqual(noncompliant.logic, cmsLogic);

  const compliance = await record("check_compliance", "check_compliance", { employeeExternalId: "emp-020", measureName: "Breast Cancer Screening" });
  assert.equal(compliance.measureVersion, "1.0.000");
  assert.deepEqual(compliance.logic, cmsLogic);

  const employee = await record("get_employee", "get_employee", { employeeExternalId: "emp-020" });
  const row = (employee.latestOutcomes as JsonRecord[]).find((o) => o.measureName === "Breast Cancer Screening")!;
  assert.equal(row.version, "1.0.000");
  assert.deepEqual(row.logic, cmsLogic);

  const explained = await record("explain_outcome", "explain_outcome", { caseId: cmsCase.id });
  assert.deepEqual(explained.logic, cmsLogic);

  // Measure tools without routing: the catalog record, nothing executed, the authored defines intact.
  const unrouted = await record("explain_rule unrouted", "explain_rule", { measureId: "cms125" });
  assert.deepEqual(unrouted.cqlDefines, ["Initial Population", "Numerator"], "authored CQL is what runs when nothing is routed");
  assert.equal(unrouted.executed, null);
  assert.ok(!("logicNote" in unrouted));

  // Now route cms125 to CMS's artifact and cms137's 2027 to the translation, as Maui does.
  const saved = { official: process.env.WORKWELL_OFFICIAL_MEASURES, derived: process.env.WORKWELL_DERIVED_MEASURES };
  process.env.WORKWELL_OFFICIAL_MEASURES = "cms125,cms137";
  process.env.WORKWELL_DERIVED_MEASURES = "cms137";
  try {
    const measures = (await record("list_measures", "list_measures", {})).results as JsonRecord[];
    const cms125 = measures.find((m) => m.measureId === "cms125")!;
    assert.equal(cms125.policyRef, "CMS125v14", "the catalog's QDM lineage is kept");
    assert.equal(cms125.version, "v1.0", "the catalog record's own version is kept");
    assert.deepEqual(
      { ecqmId: (cms125.executed as JsonRecord).ecqmId, version: (cms125.executed as JsonRecord).version, derivedFrom: (cms125.executed as JsonRecord).derivedFrom },
      { ecqmId: "CMS125FHIR", version: "1.0.000", derivedFrom: "CMS125v14" },
      "the executed version only inside `executed`, beside its own eCQM id",
    );
    assert.equal(cms125.translation, null);
    const cms137 = measures.find((m) => m.measureId === "cms137")!;
    assert.equal((cms137.translation as JsonRecord).label, "WorkWell translation of CMS137v15");
    assert.equal((cms137.translation as JsonRecord).version, "ww-2027.1");
    assert.ok(!("ecqmId" in (cms137.translation as JsonRecord)));
    const audiogram = measures.find((m) => m.measureId === "audiogram")!;
    assert.equal(audiogram.executed, null, "an authored measure names nothing executed");

    const version = await record("get_measure_version", "get_measure_version", { measureId: "cms125" });
    assert.equal(version.policyRef, "CMS125v14");
    assert.equal(version.version, "v1.0");
    assert.equal((version.executed as JsonRecord).ecqmId, "CMS125FHIR");

    // explain_rule no longer presents the authored defines as what runs: omitted, and the note says why.
    const rule = await record("explain_rule", "explain_rule", { measureId: "cms125" });
    assert.deepEqual(rule.cqlDefines, [], "the authored CQL's defines are not what this deployment runs");
    assert.match(String(rule.logicNote), /scores this measure with CMS125FHIR v1\.0\.000 \(derived from CMS125v14\)/);
    assert.match(String(rule.logicNote), /authored CQL is not what runs here/);
    assert.equal((rule.executed as JsonRecord).version, "1.0.000");
    const rule137 = await record("explain_rule cms137", "explain_rule", { measureId: "cms137" });
    assert.match(String(rule137.logicNote), /Measurement year 2027 is scored by WorkWell translation of CMS137v15 \(ww-2027\.1\), which is not a CMS measure/);
  } finally {
    if (saved.official === undefined) delete process.env.WORKWELL_OFFICIAL_MEASURES;
    else process.env.WORKWELL_OFFICIAL_MEASURES = saved.official;
    if (saved.derived === undefined) delete process.env.WORKWELL_DERIVED_MEASURES;
    else process.env.WORKWELL_DERIVED_MEASURES = saved.derived;
  }

  assert.deepEqual(qdmPairings(responses), [], "no response pairs a QDM id with the executed version");
});

/** Records the subject sets the cited-row projection is asked for, on the real store instance. */
async function withIdentityReads<T>(fn: (asked: string[][]) => Promise<T>): Promise<T> {
  const store = deps.outcomeStore;
  const original = store.listScoringIdentities.bind(store);
  const asked: string[][] = [];
  store.listScoringIdentities = async (id, opts) => {
    asked.push([...opts.subjectIds]);
    return original(id, opts);
  };
  try {
    return await fn(asked);
  } finally {
    delete (store as { listScoringIdentities?: unknown }).listScoringIdentities;
  }
}

test("#769: list_noncompliant names the logics of the rows it RETURNS only, never the whole non-compliant set", async () => {
  const everyone = ((await call("list_noncompliant", { limit: 100 })).payload.results as JsonRecord[]);
  assert.ok(everyone.length > 1, "more non-compliant cases than the page below returns");
  await withIdentityReads(async (asked) => {
    const page = ((await call("list_noncompliant", { limit: 1 })).payload.results as JsonRecord[]);
    assert.equal(page.length, 1);
    assert.deepEqual(asked.flat(), [page[0]!.employeeExternalId], "one subject read: the returned row's");
  });
});

test("#769: a run holding a patient's 2026 and 2027 rows — the MCP case tools name the row of the CASE's period", async () => {
  const run = await deps.runStore.createRun({
    scopeType: "MEASURE", scopeId: "cms137", triggeredBy: "test", requestedScope: { measureId: "cms137" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2027-12-31T23:59:59.999Z",
  });
  await deps.runStore.finalizeRun(run.id, "COMPLETED");
  // The 2026 row (CMS's artifact) is written FIRST; the 2027 case is about the 2027 row (the translation).
  await deps.outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-030", measureId: "cms137", evaluationPeriod: "2026-12-31", status: "OVERDUE", evidence: { ...CMS125_EVIDENCE, official: { ...CMS125_EVIDENCE.official, ecqmId: "137FHIR" } }, evaluatedAt: "2026-10-01T00:00:00.000Z" });
  await deps.outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-030", measureId: "cms137", evaluationPeriod: "2027-12-31", status: "OVERDUE", evidence: TRANSLATION_EVIDENCE, evaluatedAt: "2026-10-01T00:00:05.000Z" });
  const c2027 = (await deps.caseStore.upsertFromOutcome({ runId: run.id, subjectId: "emp-030", measureId: "cms137", evaluationPeriod: "2027-12-31", outcomeStatus: "OVERDUE" }))!;

  const listed = ((await call("list_cases", { status: "open", measureId: "cms137" })).payload.results as JsonRecord[]).find((r) => r.case_id === c2027.id)!;
  assert.equal((listed.logic as JsonRecord).kind, "workwell-translation", "list_cases: the case's year's row, not the run's first row");
  assert.equal(listed.measure_version, "ww-2027.1");
  const noncompliant = ((await call("list_noncompliant", { measureName: "Initiation and Engagement of Substance Use Disorder Treatment", limit: 100 })).payload.results as JsonRecord[]);
  const listedNc = noncompliant.find((r) => r.caseId === c2027.id)!;
  assert.equal((listedNc.logic as JsonRecord).kind, "workwell-translation", "list_noncompliant: the same row");
  const detail = (await call("get_case", { caseId: c2027.id })).payload;
  assert.equal((detail.logic as JsonRecord).kind, "workwell-translation", "get_case names the same row");
  assert.equal(detail.measureVersion, "ww-2027.1");
  const explained = (await call("explain_outcome", { caseId: c2027.id })).payload;
  assert.equal((explained.logic as JsonRecord).kind, "workwell-translation", "explain_outcome explains the same row");
});
