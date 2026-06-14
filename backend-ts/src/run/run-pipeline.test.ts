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

test("unsupported scope and invalid requests are typed errors", async () => {
  await assert.rejects(executeManualRun(deps, { scopeType: "ALL_PROGRAMS" }), UnsupportedScopeError);
  await assert.rejects(executeManualRun(deps, { scopeType: "MEASURE" }), InvalidRunRequestError);
  await assert.rejects(executeManualRun(deps, { scopeType: "EMPLOYEE", employeeExternalId: "ghost" }), InvalidRunRequestError);
  await assert.rejects(executeRerun(deps, crypto.randomUUID()), InvalidRunRequestError);
});
