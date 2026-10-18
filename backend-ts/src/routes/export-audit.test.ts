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

test("A1: an export that cannot be recorded is refused (503) and serves no data", async () => {
  const real = SqliteCaseEventStore.prototype.appendAudit;
  SqliteCaseEventStore.prototype.appendAudit = async () => { throw new Error("ledger unavailable"); };
  try {
    for (const res of [
      await exportsGet("/api/exports/cases?format=csv"),
      await exportsGet(`/api/exports/outcomes?format=csv&runId=${runId}`),
      await exportsGet("/api/exports/runs?format=csv"),
      await exportsGet("/api/audit-events/export?format=csv"),
      await runsGet(`/api/runs/${runId}/qrda`),
      await runsGet(`/api/runs/${runId}/measure-report?type=summary`),
      await runsGet(`/api/runs/${runId}/qrda1`),
    ]) {
      assert.equal(res!.status, 503);
      const body = await res!.text();
      assert.match(body, /export_not_recorded/);
      assert.doesNotMatch(body, /emp-006/, "no patient row leaves");
    }
  } finally {
    SqliteCaseEventStore.prototype.appendAudit = real;
  }
});

test("A1: a free-text cell that would run as a spreadsheet formula is defused; numbers are left alone", async () => {
  const csv = await (await exportsGet("/api/exports/cases?format=csv"))!.text();
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil\.test"",""Click""\)"/, "the next action is prefixed with an apostrophe");
  assert.doesNotMatch(csv, /(^|,)"?=HYPERLINK/m, "no cell starts with the formula");
  const outcomes = await (await exportsGet(`/api/exports/outcomes?format=csv&runId=${runId}`))!.text();
  assert.match(outcomes, /,emp-006,/, "an ordinary identifier is unchanged");
});
