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
import { SqliteQualitySnapshotStore } from "../stores/sqlite/quality-snapshot-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { EMPLOYEES, employeeById } from "../engine/synthetic/employee-catalog.ts";
import { executeManualRun, executeRerun, planManualRun, finishOrFail, UnsupportedScopeError, InvalidRunRequestError, type RunPipelineDeps } from "./run-pipeline.ts";
import { bucketPeriodForMeasure } from "./compliance-period.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";

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
  assert.equal(res.totalEvaluated, 14); // the 14 runnable measures
  assert.equal(res.activeMeasuresExecuted, 14);
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
  assert.equal(res.activeMeasuresExecuted, 14);
  assert.equal(res.totalEvaluated, 14 * 4, "14 runnable measures × 4 injected employees");
  const run = await deps.runStore.getRun(res.runId);
  assert.equal(run?.scopeType, "ALL_PROGRAMS");
  assert.equal(run?.scopeId, null);
  assert.equal((await deps.outcomeStore.listOutcomes(res.runId)).length, 56);
});

test("a completed population run materializes quality-over-time snapshots when the snapshot deps are present (#E16)", async () => {
  const db = await createSqliteD1(join(tmpdir(), `workwell-pipeline-snap-${crypto.randomUUID()}.sqlite`));
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const qualitySnapshots = new SqliteQualitySnapshotStore(db);
  const snapDeps: RunPipelineDeps = {
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    engine: new CqlExecutionEngine(),
    employees: EMPLOYEES.slice(0, 4), // all twh / HQ
    qualitySnapshots,
    events: new SqliteCaseEventStore(db),
  };
  const res = await executeManualRun(snapDeps, { scopeType: "MEASURE", measureId: "audiogram" });
  assert.equal(res.status, "COMPLETED");

  const rows = await qualitySnapshots.querySnapshots({ measureId: "audiogram" });
  assert.ok(rows.length > 0, "the completed run wrote snapshot rows");
  const all = rows.find((r) => r.scopeLevel === "all" && r.scopeId === "ALL");
  assert.ok(all, "an 'all' snapshot row exists for the run's month");
  assert.equal(all!.sourceRunId, res.runId);
  const tenants = rows.filter((r) => r.scopeLevel === "tenant");
  assert.equal(tenants.reduce((a, t) => a + t.numerator, 0), all!.numerator, "All = Σ tenants reconciles");
});

test("SITE manual run scopes to one site's employees, with full-population targets", async () => {
  // emp-001..004 are all site "HQ" in the injected slice.
  const res = await executeManualRun(deps, { scopeType: "SITE", site: "HQ" });
  assert.equal(res.scopeLabel, "Site: HQ");
  assert.equal(res.activeMeasuresExecuted, 14);
  assert.equal(res.totalEvaluated, 14 * 4, "all 4 HQ employees × 14 measures");
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

test("Codex P1: a failing case-audit write never fails an otherwise-complete run (logged ledger gap, not FAILED)", async () => {
  // If deps.events.appendAudit rejects on a CASE_* event (transient audit_events failure), the case is
  // already mutated; an unhandled reject would abort the loop, skip finalizeRun, and leave the run stuck
  // RUNNING (sync 500) or FAILED (async) after the mutation. The per-case audit is best-effort: the run
  // still finalizes and the gap is logged.
  const db = await createSqliteD1(join(tmpdir(), `workwell-pipeline-auditfail-${crypto.randomUUID()}.sqlite`));
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runStore = new SqliteRunStore(db);
  const failingAuditDeps: RunPipelineDeps = {
    runStore,
    outcomeStore: new SqliteOutcomeStore(db),
    caseStore: new SqliteCaseStore(db),
    engine: new CqlExecutionEngine(),
    employees: EMPLOYEES.slice(0, 4),
    actor: "cm@workwell.dev",
    events: {
      async appendAudit(input) {
        if (input.entityType === "case") throw new Error("audit_events insert failed");
        // RUN_COMPLETED (entityType "run") succeeds — it is independently best-effort.
      },
    },
  };
  // The default-date ALL_PROGRAMS run produces non-compliant subjects → case upserts → CASE_* audit
  // attempts (same slice the H1 test relies on for case events).
  const res = await executeManualRun(failingAuditDeps, { scopeType: "ALL_PROGRAMS" });
  assert.equal(res.status, "COMPLETED", "the run still finalizes COMPLETED despite the case-audit failures");
  assert.equal((await runStore.getRun(res.runId))?.status, "COMPLETED", "persisted status is COMPLETED, not FAILED/RUNNING");
  // The cases were still upserted (the mutation is not rolled back — the outcome/case are authoritative).
  assert.ok((await failingAuditDeps.caseStore!.listCases({ limit: 1000 })).length > 0, "cases were still created");
  // The ledger gap is observable via a run WARN log.
  const logs = await runStore.listLogs(res.runId, 1000);
  assert.ok(logs.some((l) => l.level === "WARN" && /Case audit.*ledger gap/.test(l.message)), "a WARN log records the audit gap");
});

test("finishOrFail finalizes the run FAILED when background completion rejects (no stuck RUNNING)", async () => {
  // A failure OUTSIDE the per-subject engine try/catch (here: recordOutcome throws) must not
  // leave an async run stuck RUNNING — finishOrFail catches it and finalizes FAILED.
  const failing: RunPipelineDeps = {
    ...deps,
    outcomeStore: {
      ...deps.outcomeStore,
      async recordOutcome() {
        throw new Error("store down");
      },
    } as RunPipelineDeps["outcomeStore"],
  };
  const planned = await planManualRun(failing, { scopeType: "EMPLOYEE", employeeExternalId: "emp-001" });
  assert.equal((await deps.runStore.getRun(planned.run.id))?.status, "RUNNING", "planned run starts RUNNING");
  await finishOrFail(failing, planned); // must not throw
  assert.equal((await deps.runStore.getRun(planned.run.id))?.status, "FAILED", "finalized FAILED, not left RUNNING");
});

test("unsupported scope and invalid requests are typed errors", async () => {
  await assert.rejects(executeManualRun(deps, { scopeType: "CASE" }), UnsupportedScopeError);
  await assert.rejects(executeManualRun(deps, { scopeType: "MEASURE" }), InvalidRunRequestError);
  await assert.rejects(executeManualRun(deps, { scopeType: "EMPLOYEE", employeeExternalId: "ghost" }), InvalidRunRequestError);
  await assert.rejects(executeRerun(deps, crypto.randomUUID()), InvalidRunRequestError);
});

test("nightly idempotency (#150 H1): same-cycle reruns bucket to one cycle period, never duplicating cases", async () => {
  // Two ALL_PROGRAMS runs with NO evaluationDate → today — the nightly-cron shape. Both bucket
  // to the same compliance-cycle anchor, so the second run upserts the same cases (no fresh
  // cohort) and every opened case sits on a cycle anchor (Jan 1 / Jul 1), not a raw run date.
  //
  // Isolated stores (own db): the file's shared `deps` accumulates cases from prior tests, which —
  // now that the H2 fix correctly leaves already-terminal cases untouched (no last_run_id drift) —
  // would make the lastRunId proxy below unreliable. A fresh db makes this a true from-scratch nightly.
  const db = await createSqliteD1(join(tmpdir(), `workwell-pipeline-nightly-${crypto.randomUUID()}.sqlite`));
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const caseStore = new SqliteCaseStore(db);
  const nightlyDeps: RunPipelineDeps = {
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    caseStore,
    engine: new CqlExecutionEngine(),
    employees: EMPLOYEES.slice(0, 4),
  };
  const r1 = await executeManualRun(nightlyDeps, { scopeType: "ALL_PROGRAMS" });
  const afterFirst = (await caseStore.listCases({})).length;
  const r2 = await executeManualRun(nightlyDeps, { scopeType: "ALL_PROGRAMS" });
  const all = await caseStore.listCases({});
  assert.equal(all.length, afterFirst, "the second nightly run creates 0 new cases (bucketed → idempotent)");
  const mine = all.filter((c) => c.lastRunId === r1.runId || c.lastRunId === r2.runId);
  assert.ok(mine.length >= 1, "the runs opened at least one case");
  assert.ok(
    mine.every((c) => /-(01|07)-01$/.test(c.evaluationPeriod)),
    "evaluation_period is a compliance-cycle anchor (Jan 1 / Jul 1), not the raw run date",
  );
});

test("Fable H1: a population run emits RUN_COMPLETED + case audit events (the hard-rule fix)", async () => {
  const db = await createSqliteD1(join(tmpdir(), `workwell-pipeline-audit-${crypto.randomUUID()}.sqlite`));
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const captured: { eventType: string; entityType: string; refRunId: string | null; actor: string }[] = [];
  const auditDeps: RunPipelineDeps = {
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    caseStore: new SqliteCaseStore(db),
    engine: new CqlExecutionEngine(),
    employees: EMPLOYEES.slice(0, 4),
    actor: "cm@workwell.dev", // authenticated actor — audit rows must use THIS, not triggeredBy (Codex P1)
    events: {
      async appendAudit(input) {
        captured.push({ eventType: input.eventType, entityType: input.entityType, refRunId: input.refRunId, actor: input.actor });
      },
    },
  };
  // triggeredBy is a spoofable body field / trigger label; the audit actor must ignore it.
  const res = await executeManualRun(auditDeps, { scopeType: "ALL_PROGRAMS", triggeredBy: "seed:scale" });
  assert.ok(captured.length > 0 && captured.every((e) => e.actor === "cm@workwell.dev"), "audit actor is the authenticated actor, never the triggeredBy label");

  // The run's terminal state is audited (previously the highest-volume state change wrote nothing).
  const runEvents = captured.filter((e) => e.eventType === "RUN_COMPLETED" && e.entityType === "run");
  assert.equal(runEvents.length, 1, "exactly one RUN_COMPLETED");
  assert.equal(runEvents[0]!.refRunId, res.runId);

  // Non-compliant subjects open cases, and each creation is audited (CASE_CREATED).
  const caseEvents = captured.filter((e) => e.entityType === "case");
  assert.ok(caseEvents.length >= 1, "at least one case audit event");
  assert.ok(
    caseEvents.every((e) => ["CASE_CREATED", "CASE_UPDATED", "CASE_RESOLVED", "CASE_EXCLUDED"].includes(e.eventType)),
    "case events use the mapped vocabulary",
  );

  // Idempotent re-confirm: a second run re-confirms the same OPEN cases → NO new CASE_UPDATED noise,
  // but the run itself is still audited (a nightly run records one RUN_COMPLETED, not hundreds of events).
  captured.length = 0;
  await executeManualRun(auditDeps, { scopeType: "ALL_PROGRAMS", triggeredBy: "scheduler" });
  assert.equal(captured.filter((e) => e.eventType === "RUN_COMPLETED").length, 1, "second run also audited");
  assert.equal(
    captured.filter((e) => e.eventType === "CASE_UPDATED").length,
    0,
    "re-confirmed same-outcome cases emit no CASE_UPDATED (UNCHANGED → silent refresh)",
  );
});

// --- segment applicability gates case creation (#183 E11.3) ----------------
// A Welder-only segment whose applicable rule-set is ["audiogram"]; emp-007 is Office Staff,
// so audiogram is NOT applicable to them under this enabled segment.
const welderSegment = (): HydratedSegment => ({
  id: crypto.randomUUID(),
  name: "Welders — Audiogram",
  description: "",
  enabled: true,
  rule: { match: "ANY", conditions: [{ attr: "role", op: "equals", value: "Welder" }] },
  measureIds: ["audiogram"],
  overrides: [],
  createdBy: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// Stub engine forces a deterministic OVERDUE (non-compliant) outcome regardless of synthetic config.
const overdueEngine: RunPipelineDeps["engine"] = {
  async evaluate() {
    return {
      subjectId: "ignored",
      measure: "Audiogram",
      outcome: "OVERDUE",
      evidence: { expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] },
    };
  },
};

test("gated: an out-of-cohort (subject, measure) creates NO case, but the outcome IS persisted", async () => {
  const office = employeeById("emp-007")!; // Office Staff — not a Welder
  const gatedDeps: RunPipelineDeps = {
    ...deps,
    engine: overdueEngine,
    employees: [office],
    segments: [welderSegment()],
  };
  const res = await executeManualRun(gatedDeps, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2097-03-03" });

  // The non-compliant outcome is still persisted (CQL/recordOutcome is unconditional — ADR-008).
  const outcomes = await deps.outcomeStore.listOutcomes(res.runId);
  assert.equal(outcomes.length, 1, "the OVERDUE outcome was persisted");
  assert.equal(outcomes[0]!.status, "OVERDUE");
  assert.equal(outcomes[0]!.subjectId, "emp-007");

  // No case was created for (emp-007, audiogram) — applicability gated it. This run is the only
  // one that touched emp-007/audiogram, so any case here would be lastRunId === res.runId.
  const mine = (await deps.caseStore!.listCases({})).filter(
    (c) => c.lastRunId === res.runId && c.employeeId === "emp-007" && c.measureId === "audiogram",
  );
  assert.equal(mine.length, 0, "out-of-cohort outcome creates no case");
});

test("reversibility: with zero enabled segments, the same scenario DOES create a case", async () => {
  const office = employeeById("emp-007")!;
  const openDeps: RunPipelineDeps = {
    ...deps,
    engine: overdueEngine,
    employees: [office],
    segments: [], // zero enabled segments ⇒ all applicable (cases created exactly as today)
  };
  const res = await executeManualRun(openDeps, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2096-04-04" });

  // The case's evaluation_period is bucketed to a compliance cycle (not the raw date), so key on
  // (employee, measure, this run) instead of the literal `period`.
  const mine = (await deps.caseStore!.listCases({})).filter(
    (c) => c.lastRunId === res.runId && c.employeeId === "emp-007" && c.measureId === "audiogram",
  );
  assert.equal(mine.length, 1, "no segments ⇒ a case IS created for the non-compliant outcome");
});

// --- M10 (cycle rollover) + M11 (resolve is not gated) ---------------------
const compliantEngine: RunPipelineDeps["engine"] = {
  async evaluate() {
    return {
      subjectId: "ignored",
      measure: "Audiogram",
      outcome: "COMPLIANT",
      evidence: { expressionResults: [{ define: "Outcome Status", result: "COMPLIANT" }] },
    };
  },
};

/** A self-contained floor + all stores (incl. events) for the rollover/resolve tests. */
async function freshPipelineDb() {
  const p = join(tmpdir(), `workwell-pipeline-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(p);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return {
    p,
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    caseStore: new SqliteCaseStore(db),
    events: new SqliteCaseEventStore(db),
  };
}

test("Fable M10: a still-open PRIOR-cycle case is closed (CYCLE_ROLLED_OVER, audited) when the subject is re-run", async () => {
  const { p, runStore, outcomeStore, caseStore, events } = await freshPipelineDb();
  const office = employeeById("emp-007")!;
  try {
    // Seed a stale prior-period OPEN case for (emp-007, audiogram).
    const seedRun = await runStore.createRun({ scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed", requestedScope: {}, measurementPeriodStart: "2020-01-01T00:00:00.000Z", measurementPeriodEnd: "2020-12-31T00:00:00.000Z" });
    const stale = await caseStore.upsertFromOutcome({ runId: seedRun.id, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: "2020-01-01", outcomeStatus: "OVERDUE" });
    assert.equal(stale?.status, "OPEN");

    const d: RunPipelineDeps = { runStore, outcomeStore, caseStore, events, engine: overdueEngine, employees: [office], segments: [] };
    const res = await executeManualRun(d, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2097-03-03" });

    const closed = await caseStore.getCase(stale!.id);
    assert.equal(closed?.status, "RESOLVED", "the prior-cycle case is closed on the new run");
    assert.equal(closed?.closedReason, "CYCLE_ROLLED_OVER");
    assert.equal(closed?.closedBy, null, "system closure (not a human decision)");
    const rolled = (await events.auditEventsByRun(res.runId)).filter(
      (a) => a.eventType === "CASE_RESOLVED" && (a.payload as { reason?: string })?.reason === "CYCLE_ROLLED_OVER",
    );
    assert.equal(rolled.length, 1, "the rollover close is audited");
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("Fable M11: an out-of-cohort COMPLIANT outcome still RESOLVES an existing open case (creation gated, resolution not)", async () => {
  const { p, runStore, outcomeStore, caseStore, events } = await freshPipelineDb();
  const office = employeeById("emp-007")!; // Office Staff — out-of-cohort for the Welder audiogram segment
  try {
    const period = bucketPeriodForMeasure("audiogram", "2097-03-03");
    const seedRun = await runStore.createRun({ scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed", requestedScope: {}, measurementPeriodStart: "2097-01-01T00:00:00.000Z", measurementPeriodEnd: "2097-12-31T00:00:00.000Z" });
    const open = await caseStore.upsertFromOutcome({ runId: seedRun.id, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: period, outcomeStatus: "OVERDUE" });
    assert.equal(open?.status, "OPEN");

    // emp-007 is out-of-cohort (welder segment) AND now evaluates COMPLIANT.
    const d: RunPipelineDeps = { runStore, outcomeStore, caseStore, events, engine: compliantEngine, employees: [office], segments: [welderSegment()] };
    await executeManualRun(d, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2097-03-03" });

    const after = await caseStore.getCase(open!.id);
    assert.equal(after?.status, "RESOLVED", "the compliant outcome closes the case even though the subject left the cohort");
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});
