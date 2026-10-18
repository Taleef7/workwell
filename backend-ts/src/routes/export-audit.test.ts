/**
 * A bulk download is recorded before it leaves, and is refused when it cannot be (production readiness A1).
 *
 * Every export (the §6 CSVs, the audit ledger, QRDA I/III, MeasureReport) writes `EXPORT_GENERATED` naming
 * the export, its run and its filters; when that write fails the route answers 503 `export_not_recorded`
 * and no row is served. The routes resolve their own stores, so a failed write is made by patching the
 * event store's prototype, as `segments.test.ts` does.
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
import { handleRuns } from "./runs.ts";
import { toCsv, text } from "../export/csv.ts";

const dbPath = join(tmpdir(), `workwell-export-audit-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let db: unknown;
let runId: string;

before(async () => {
  db = await createSqliteD1(dbPath);
  await (db as { exec: (sql: string) => Promise<void> }).exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const run = await new SqliteRunStore(db as never).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
    status: "COMPLETED", startedAt: "2026-06-13T00:00:00.000Z", completedAt: "2026-06-13T00:01:00.000Z",
  } as never);
  runId = run.id;
  await new SqliteOutcomeStore(db as never).recordOutcome({
    runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", status: "OVERDUE",
    evidence: { expressionResults: [{ define: "Days Since Last Audiogram", result: 420 }] },
  });
  const c = await new SqliteCaseStore(db as never).upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  // A next action someone typed that a spreadsheet would run as a formula.
  await new SqliteCaseStore(db as never).patchCase(c!.id, { nextAction: "=HYPERLINK(\"http://evil.test\",\"Click\")" });
});
after(() => {
  try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
});

const exportsGet = (path: string) => handleExports(new Request(`http://x${path}`), env as never, "cm@workwell.dev");
const runsGet = (path: string) => handleRuns(new Request(`http://x${path}`), env as never, "admin@workwell.dev");
const exportEvents = async () =>
  (await new SqliteCaseEventStore(db as never).listAuditEvents()).filter((e) => e.eventType === "EXPORT_GENERATED");

test("A1: every bulk download is recorded with who took it, which export, its run and its filters", async () => {
  const before = (await exportEvents()).length;
  const paths: Array<[string, () => Promise<Response | null>]> = [
    ["runs_csv", () => exportsGet("/api/exports/runs?format=csv&status=COMPLETED")],
    ["outcomes_csv", () => exportsGet(`/api/exports/outcomes?format=csv&runId=${runId}`)],
    ["cases_csv", () => exportsGet("/api/exports/cases?format=csv&search=emp")],
    ["audit_csv", () => exportsGet("/api/audit-events/export?format=csv")],
    ["qrda3", () => runsGet(`/api/runs/${runId}/qrda`)],
    ["measure_report", () => runsGet(`/api/runs/${runId}/measure-report?type=summary`)],
    ["measure_report", () => runsGet(`/api/runs/${runId}/measure-report?type=individual`)],
    ["qrda1", () => runsGet(`/api/runs/${runId}/qrda1`)],
  ];
  for (const [kind, call] of paths) {
    const res = (await call())!;
    assert.equal(res.status, 200, `${kind}: ${await res.clone().text()}`);
    await res.text();
  }
  const events = (await exportEvents()).slice(before);
  assert.deepEqual(events.map((e) => e.payload.kind), paths.map(([kind]) => kind));
  const cases = events.find((e) => e.payload.kind === "cases_csv")!;
  assert.equal(cases.actor, "cm@workwell.dev");
  assert.deepEqual(cases.payload.params, { format: "csv", search: "emp" }, "the filters it was taken under");
  assert.equal(events.find((e) => e.payload.kind === "outcomes_csv")!.refRunId, runId);
  assert.equal(events.find((e) => e.payload.kind === "qrda1")!.refRunId, runId);
  assert.equal(events.find((e) => e.payload.kind === "measure_report")!.actor, "admin@workwell.dev");
});

test("A1: an export that cannot be recorded is refused (503) and serves nothing", async () => {
  const real = SqliteCaseEventStore.prototype.appendAudit;
  SqliteCaseEventStore.prototype.appendAudit = async () => { throw new Error("ledger unavailable"); };
  // Every row reader the exports use, counted: a refused export must not have read the data it refused.
  let rowReads = 0;
  const counted: Array<[object, string]> = [
    [SqliteOutcomeStore.prototype, "listOutcomes"],
    [SqliteCaseStore.prototype, "listCases"],
    [SqliteCaseEventStore.prototype, "listAuditEvents"],
    [SqliteCaseEventStore.prototype, "streamAuditEvents"],
  ];
  const originals = counted.map(([proto, name]) => (proto as Record<string, unknown>)[name]);
  counted.forEach(([proto, name], i) => {
    const original = originals[i] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== "function") return;
    (proto as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) { rowReads++; return original.apply(this, args); };
  });
  try {
    // QRDA I must read its rows before it can refuse a run scored by mixed or translated logic, so it reads
    // and then serves nothing; every other export is refused before its first row read.
    const calls: Array<[string, () => Promise<Response | null>, boolean]> = [
      ["cases csv", () => exportsGet("/api/exports/cases?format=csv"), false],
      ["outcomes csv", () => exportsGet(`/api/exports/outcomes?format=csv&runId=${runId}`), false],
      ["runs csv", () => exportsGet("/api/exports/runs?format=csv"), false],
      ["audit csv", () => exportsGet("/api/audit-events/export?format=csv"), false],
      ["qrda3", () => runsGet(`/api/runs/${runId}/qrda`), false],
      ["measure report", () => runsGet(`/api/runs/${runId}/measure-report?type=summary`), false],
      ["qrda1", () => runsGet(`/api/runs/${runId}/qrda1`), true],
    ];
    for (const [name, call, readsForItsChecks] of calls) {
      rowReads = 0;
      const res = (await call())!;
      assert.equal(res.status, 503, name);
      const body = await res.text();
      assert.match(body, /export_not_recorded/, name);
      assert.doesNotMatch(body, /emp-006/, `${name}: no row leaves`);
      if (!readsForItsChecks) assert.equal(rowReads, 0, `${name}: refused before any row was read`);
    }
  } finally {
    SqliteCaseEventStore.prototype.appendAudit = real;
    counted.forEach(([proto, name], i) => { if (typeof originals[i] === "function") (proto as Record<string, unknown>)[name] = originals[i]; });
  }
});

test("A1: a free-text cell that would run as a spreadsheet formula is defused; numbers are left alone", async () => {
  const csv = await (await exportsGet("/api/exports/cases?format=csv"))!.text();
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil\.test"",""Click""\)"/, "the next action is prefixed with an apostrophe");
  assert.doesNotMatch(csv, /(^|,)"?=HYPERLINK/m, "no cell starts with the formula");
  const outcomes = await (await exportsGet(`/api/exports/outcomes?format=csv&runId=${runId}`))!.text();
  assert.match(outcomes, /,emp-006,/, "an ordinary identifier is unchanged");
  // Only text is defused: a negative number is written as a number.
  assert.equal(toCsv(["a", "b"], [[text("-5"), -5]]), "a,b\r\n'-5,-5");
});

test("A1: a run id the caller made up never reaches the ledger as a reference, nor the audit CSV as a formula", async () => {
  const forged = '=HYPERLINK("http://evil.test","x")';
  const res = (await exportsGet(`/api/exports/outcomes?format=csv&runId=${encodeURIComponent(forged)}`))!;
  assert.equal(res.status, 200);
  await res.text();
  const recorded = (await exportEvents()).at(-1)!;
  assert.equal(recorded.refRunId, null, "only a run that exists is referenced");
  assert.equal((recorded.payload.params as Record<string, string>).runId, forged, "what was asked for stays in the filters");
  // And whatever reference a row does carry is written as text, never as a formula.
  await new SqliteCaseEventStore(db as never).appendAudit({
    eventType: "CASE_ESCALATED", entityType: "case", entityId: "c-x", actor: "@cm", refRunId: "=1+1", refCaseId: "+SUM(A1)",
    refMeasureVersionId: null, payload: {},
  });
  const ledger = await (await exportsGet("/api/audit-events/export?format=csv"))!.text();
  assert.doesNotMatch(ledger, /(^|,)"?[=+@]/m, "no ledger cell starts with a formula character");
  assert.match(ledger, /,'=1\+1,/, "the run reference is defused, not dropped");
});
