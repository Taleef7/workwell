/**
 * Run-pipeline integration (#107): manual MEASURE/EMPLOYEE runs + rerun over a real
 * SQLite floor + the JVM-free engine, with a small injected population for speed.
 *   node --import tsx --test src/run/run-pipeline.test.ts
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
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { executeManualRun, executeRerun, UnsupportedScopeError, InvalidRunRequestError, type RunPipelineDeps } from "./run-pipeline.ts";

const dbPath = join(tmpdir(), `workwell-pipeline-${crypto.randomUUID()}.sqlite`);
let deps: RunPipelineDeps;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  deps = {
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    caseStore: new SqliteCaseStore(db),
    engine: new CqlExecutionEngine(),
    employees: EMPLOYEES.slice(0, 4), // emp-001..004 — keeps the test fast
  };
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("MEASURE manual run evaluates the population, persists outcomes, and completes", async () => {
  const res = await executeManualRun(deps, { scopeType: "MEASURE", measureId: "audiogram" });
  assert.equal(res.scopeType, "MEASURE");
  assert.equal(res.status, "COMPLETED");
  assert.equal(res.totalEvaluated, 4);
  assert.equal(res.activeMeasuresExecuted, 1);
  assert.deepEqual(res.measuresExecuted, ["Audiogram"]);
  assert.ok(res.compliant + res.nonCompliant <= 4);

  const run = await deps.runStore.getRun(res.runId);
  assert.equal(run?.status, "COMPLETED");
  assert.ok(run?.completedAt, "completed_at stamped → durationMs computable");
  assert.equal((await deps.outcomeStore.listOutcomes(res.runId)).length, 4);
});

test("EMPLOYEE manual run evaluates all runnable measures for one employee", async () => {
  const res = await executeManualRun(deps, { scopeType: "EMPLOYEE", employeeExternalId: "emp-001" });
  assert.equal(res.scopeLabel, "Employee: emp-001");
  assert.equal(res.totalEvaluated, 10); // the 10 runnable measures
  assert.equal(res.activeMeasuresExecuted, 10);
});

test("rerun re-executes the prior run's scope as a NEW run", async () => {
  const first = await executeManualRun(deps, { scopeType: "MEASURE", measureId: "audiogram" });
  const again = await executeRerun(deps, first.runId);
  assert.notEqual(again.runId, first.runId, "rerun creates a new run");
  assert.equal(again.scopeType, "MEASURE");
  assert.equal(again.totalEvaluated, 4);
});

test("a run upserts cases from non-compliant outcomes — idempotent on rerun (no duplicates)", async () => {
  const caseStore = deps.caseStore!;
  // Unique evaluation period isolates this test's cases in the shared DB.
  const period = "2099-01-01";
  const res = await executeManualRun(deps, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: period });
  const mine = async () => (await caseStore.listCases({})).filter((c) => c.evaluationPeriod === period);
  const before1 = await mine();
  assert.ok(before1.length >= 1, "non-compliant outcomes opened cases for this period");
  assert.ok(before1.every((c) => c.lastRunId === res.runId));

  // rerun reuses the persisted evaluationDate → same (employee, measure, period) keys → upsert.
  await executeRerun(deps, res.runId);
  assert.equal((await mine()).length, before1.length, "rerun upserts the same cases, never duplicates");
});

test("a subject evaluation failure is non-fatal but flags the run PARTIAL_FAILURE", async () => {
  const failing: RunPipelineDeps = {
    ...deps,
    engine: {
      async evaluate() {
        throw new Error("boom");
      },
    },
  };
  const res = await executeManualRun(failing, { scopeType: "MEASURE", measureId: "audiogram" });
  assert.equal(res.status, "PARTIAL_FAILURE");
  assert.match(res.message, /evaluation failure/);

  const run = await deps.runStore.getRun(res.runId);
  assert.equal(run?.status, "PARTIAL_FAILURE", "terminal status is not silently COMPLETED");

  const outcomes = await deps.outcomeStore.listOutcomes(res.runId);
  assert.equal(outcomes.length, 4, "every subject is still persisted (run not aborted)");
  assert.ok(outcomes.every((o) => o.status === "MISSING_DATA"));
  assert.ok(outcomes.every((o) => (o.evidence as { evaluationError?: string }).evaluationError));
});

test("ALL_PROGRAMS manual run evaluates every runnable measure × the whole population", async () => {
  const res = await executeManualRun(deps, { scopeType: "ALL_PROGRAMS" });
  assert.equal(res.scopeType, "ALL_PROGRAMS");
  assert.equal(res.scopeLabel, "All Programs");
  assert.equal(res.activeMeasuresExecuted, 10);
  assert.equal(res.totalEvaluated, 10 * 4, "10 runnable measures × 4 injected employees");
  const run = await deps.runStore.getRun(res.runId);
  assert.equal(run?.scopeType, "ALL_PROGRAMS");
  assert.equal(run?.scopeId, null);
  assert.equal((await deps.outcomeStore.listOutcomes(res.runId)).length, 40);
});

test("SITE manual run scopes to one site's employees, with full-population targets", async () => {
  // emp-001..004 are all site "HQ" in the injected slice.
  const res = await executeManualRun(deps, { scopeType: "SITE", site: "HQ" });
  assert.equal(res.scopeLabel, "Site: HQ");
  assert.equal(res.activeMeasuresExecuted, 10);
  assert.equal(res.totalEvaluated, 10 * 4, "all 4 HQ employees × 10 measures");
  const run = await deps.runStore.getRun(res.runId);
  assert.equal(run?.scopeType, "SITE");
  assert.equal(run?.site, "HQ", "site derived from requestedScope drives the list filter");

  // An employee's outcome must match between a SITE run and an ALL_PROGRAMS run (same target).
  const all = await executeManualRun(deps, { scopeType: "ALL_PROGRAMS", evaluationDate: "2098-02-02" });
  const siteRun = await executeManualRun(deps, { scopeType: "SITE", site: "HQ", evaluationDate: "2098-02-02" });
  const pick = (rows: { subjectId: string; measureId: string; status: string }[]) =>
    rows.filter((o) => o.subjectId === "emp-001").sort((a, b) => a.measureId.localeCompare(b.measureId)).map((o) => `${o.measureId}:${o.status}`);
  const allRows = await deps.outcomeStore.listOutcomes(all.runId);
  const siteRows = await deps.outcomeStore.listOutcomes(siteRun.runId);
  assert.deepEqual(pick(siteRows), pick(allRows), "emp-001 outcomes identical across SITE and ALL_PROGRAMS");
});

test("SITE run with an unknown site is an invalid request", async () => {
  await assert.rejects(executeManualRun(deps, { scopeType: "SITE", site: "Atlantis" }), InvalidRunRequestError);
  await assert.rejects(executeManualRun(deps, { scopeType: "SITE" }), InvalidRunRequestError);
});

test("unsupported scope and invalid requests are typed errors", async () => {
  await assert.rejects(executeManualRun(deps, { scopeType: "CASE" }), UnsupportedScopeError);
  await assert.rejects(executeManualRun(deps, { scopeType: "MEASURE" }), InvalidRunRequestError);
  await assert.rejects(executeManualRun(deps, { scopeType: "EMPLOYEE", employeeExternalId: "ghost" }), InvalidRunRequestError);
  await assert.rejects(executeRerun(deps, crypto.randomUUID()), InvalidRunRequestError);
});
