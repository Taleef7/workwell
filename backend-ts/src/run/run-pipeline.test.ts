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
import { executeManualRun, executeRerun, planManualRun, finishOrFail, runningResponse, UnsupportedScopeError, InvalidRunRequestError, type RunPipelineDeps } from "./run-pipeline.ts";
import { bucketPeriodForMeasure } from "./compliance-period.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import type { AlertChannel, RunAlert } from "./alert-channel.ts";
import { fixtureWebChartClient, type WebChartClient } from "../engine/ingress/webchart/webchart-client.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { ROSTER_ELIGIBLE_MEASURES } from "../engine/ingress/enrollment/roster.ts";
import { profileForId, replaceLiveDirectory } from "../engine/ingress/webchart/live-directory.ts";

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

// ---- #264 observability: failed-run alerts --------------------------------------------------------

function countingAlertChannel(sink: RunAlert[]): AlertChannel {
  return {
    name: "test",
    async send(alert) {
      sink.push(alert);
    },
  };
}

test("#264: PARTIAL_FAILURE population run emits exactly one alert; COMPLETED emits none", async () => {
  const partialAlerts: RunAlert[] = [];
  const partial: RunPipelineDeps = {
    ...deps,
    engine: {
      async evaluate() {
        throw new Error("boom");
      },
    },
    alertChannels: [countingAlertChannel(partialAlerts)],
  };
  const partialRes = await executeManualRun(partial, { scopeType: "MEASURE", measureId: "audiogram" });
  assert.equal(partialRes.status, "PARTIAL_FAILURE");
  assert.equal(partialAlerts.length, 1, "exactly one alert on PARTIAL_FAILURE");
  assert.equal(partialAlerts[0]!.kind, "RUN_PARTIAL_FAILURE");
  assert.equal(partialAlerts[0]!.runId, partialRes.runId);
  assert.ok((partialAlerts[0]!.failures ?? 0) > 0);

  const okAlerts: RunAlert[] = [];
  const ok: RunPipelineDeps = {
    ...deps,
    alertChannels: [countingAlertChannel(okAlerts)],
  };
  const okRes = await executeManualRun(ok, { scopeType: "MEASURE", measureId: "audiogram" });
  assert.equal(okRes.status, "COMPLETED");
  assert.equal(okAlerts.length, 0, "COMPLETED emits no alert");
});

test("#264: FAILED finishOrFail emits exactly one alert", async () => {
  const alerts: RunAlert[] = [];
  const failing: RunPipelineDeps = {
    ...deps,
    outcomeStore: {
      ...deps.outcomeStore,
      async recordOutcome() {
        throw new Error("store down");
      },
    } as RunPipelineDeps["outcomeStore"],
    alertChannels: [countingAlertChannel(alerts)],
  };
  const planned = await planManualRun(failing, { scopeType: "MEASURE", measureId: "audiogram" });
  await finishOrFail(failing, planned);
  assert.equal((await deps.runStore.getRun(planned.run.id))?.status, "FAILED");
  assert.equal(alerts.length, 1, "exactly one alert on FAILED");
  assert.equal(alerts[0]!.kind, "RUN_FAILED");
  assert.equal(alerts[0]!.runId, planned.run.id);
});

test("#264: alert-channel failure is best-effort — never fails an otherwise-complete PARTIAL_FAILURE run", async () => {
  const boomChannel: AlertChannel = {
    name: "boom",
    async send() {
      throw new Error("alert sink down");
    },
  };
  const failing: RunPipelineDeps = {
    ...deps,
    engine: {
      async evaluate() {
        throw new Error("eval boom");
      },
    },
    alertChannels: [boomChannel],
  };
  const res = await executeManualRun(failing, { scopeType: "MEASURE", measureId: "audiogram" });
  assert.equal(res.status, "PARTIAL_FAILURE", "run still finalizes despite alert throw");
  assert.equal((await deps.runStore.getRun(res.runId))?.status, "PARTIAL_FAILURE");
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

const WEBCHART_ENV = {
  WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
  WORKWELL_WEBCHART_API_KEY: "fixture-key",
};

const patientOnly = (id: string, withDegradedMarker = false): unknown => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id, name: [{ given: ["Live"], family: id }] } },
    ...(withDegradedMarker
      ? [{ resource: { resourceType: "OperationOutcome", issue: [{ severity: "warning", code: "processing" }] } }]
      : []),
  ],
});

test("configured planning stays network-free, attaches only a descriptor, and seam-off work stays byte-identical", async () => {
  let fetches = 0;
  const client: WebChartClient = {
    kind: "blocked-test",
    async fetchPatientPayloads() {
      fetches++;
      return [patientOnly("should-not-load")];
    },
  };
  const configured = await planManualRun(
    { ...deps, webChartEnv: WEBCHART_ENV, webChartClient: client },
    { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2026-06-01" },
  );
  assert.equal(fetches, 0, "planning never starts WebChart I/O");
  assert.deepEqual(configured.livePopulation, {
    host: "webchart.test",
    pageSize: 100,
    enrollmentJson: undefined,
  });
  assert.ok(!("bundles" in configured.livePopulation!), "descriptor never carries fetched clinical data");

  const baseline = await planManualRun(deps, { scopeType: "ALL_PROGRAMS", evaluationDate: "2026-06-01" });
  const seamOff = await planManualRun(
    { ...deps, webChartEnv: {} },
    { scopeType: "ALL_PROGRAMS", evaluationDate: "2026-06-01" },
  );
  const serializedResponse = (planned: typeof baseline) => JSON.stringify(
    runningResponse({ ...planned, run: { id: "fixed-run-id" } }),
  );
  assert.equal(
    serializedResponse(seamOff),
    serializedResponse(baseline),
    "all-unset WebChart variables preserve the complete serialized async route response",
  );
});

test("configured WebChart SITE scope is rejected before run creation", async () => {
  const countBefore = (await deps.runStore.listRuns(1000)).length;
  await assert.rejects(
    planManualRun(
      { ...deps, webChartEnv: WEBCHART_ENV, webChartClient: fixtureWebChartClient([]) },
      { scopeType: "SITE", site: "WebChart" },
    ),
    UnsupportedScopeError,
  );
  assert.equal((await deps.runStore.listRuns(1000)).length, countBefore, "unsupported scope creates no run");
});

test("configured WebChart EMPLOYEE scope is rejected before run creation", async () => {
  const countBefore = (await deps.runStore.listRuns(1000)).length;
  await assert.rejects(
    planManualRun(
      { ...deps, webChartEnv: WEBCHART_ENV },
      { scopeType: "EMPLOYEE", employeeExternalId: "wc|live-employee" },
    ),
    UnsupportedScopeError,
  );
  assert.equal((await deps.runStore.listRuns(1000)).length, countBefore, "unsupported scope creates no run");
});

test("live bundles evaluate through the unchanged CQL engine and persist wc-prefixed outcomes", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  try {
    const rawEmployee = { ...EMPLOYEES[4]!, externalId: "live-cql-1", name: "Live CQL" };
    const rawBundle = buildSyntheticBundle(
      rawEmployee,
      deriveExamConfig(MEASURE_BINDINGS.audiogram!, "COMPLIANT"),
      "2026-06-01",
    );
    const liveDeps: RunPipelineDeps = {
      runStore,
      outcomeStore,
      engine: new CqlExecutionEngine(),
      employees: [],
      webChartEnv: WEBCHART_ENV,
      webChartClient: fixtureWebChartClient([rawBundle]),
    };
    const result = await executeManualRun(liveDeps, {
      scopeType: "MEASURE",
      measureId: "audiogram",
      evaluationDate: "2026-06-01",
    });
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.totalEvaluated, 1);
    const rows = await outcomeStore.listOutcomes(result.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.subjectId, "wc|live-cql-1");
    assert.equal(rows[0]!.status, "COMPLIANT", "CQL alone derives the live outcome");
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("a degraded Patient-only WebChart bundle evaluates MISSING_DATA and reports degradedCount", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  const audits: unknown[] = [];
  try {
    const result = await executeManualRun({
      runStore,
      outcomeStore,
      engine: new CqlExecutionEngine(),
      employees: [],
      webChartEnv: WEBCHART_ENV,
      webChartClient: fixtureWebChartClient([patientOnly("degraded-patient", true)]),
      events: { async appendAudit(input) { audits.push(input); } },
    }, {
      scopeType: "MEASURE",
      measureId: "audiogram",
      evaluationDate: "2026-06-01",
    });

    const rows = await outcomeStore.listOutcomes(result.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.subjectId, "wc|degraded-patient");
    assert.equal(rows[0]!.status, "MISSING_DATA", "the unchanged CQL engine owns the degraded outcome");
    const terminal = audits.find((entry) =>
      (entry as { eventType?: string }).eventType === "RUN_COMPLETED"
    ) as { payload: { liveTenant?: { degradedCount?: number; status?: string } } } | undefined;
    assert.equal(terminal?.payload.liveTenant?.degradedCount, 1);
    assert.equal(terminal?.payload.liveTenant?.status, "COMPLETED");
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("live enrollment uses explicit raw Patient ids when set and enroll-all when unset", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  const seen = new Map<string, unknown>();
  const captureEngine: RunPipelineDeps["engine"] = {
    async evaluate(input) {
      seen.set((input.patientBundle as { entry: Array<{ resource: { id?: string; resourceType?: string } }> }).entry[0]!.resource.id!, input.patientBundle);
      return {
        subjectId: "ignored",
        measure: "Audiogram",
        outcome: "MISSING_DATA",
        evidence: { expressionResults: [{ define: "Outcome Status", result: "MISSING_DATA" }] },
      };
    },
  };
  try {
    const run = async (id: string, enrollmentJson?: string) => executeManualRun({
      runStore,
      outcomeStore,
      engine: captureEngine,
      employees: [],
      webChartEnv: { ...WEBCHART_ENV, WORKWELL_WEBCHART_ENROLLMENT_JSON: enrollmentJson },
      webChartClient: fixtureWebChartClient([patientOnly(id)]),
    }, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2026-06-01" });

    await run("explicit-patient", JSON.stringify({ "explicit-patient": ["audiogram"] }));
    await run("default-patient");
    await run("omitted-patient", JSON.stringify({ "another-patient": ["audiogram"] }));
    assert.ok(ROSTER_ELIGIBLE_MEASURES.has("audiogram"));
    for (const id of ["explicit-patient", "default-patient"]) {
      const resources = (seen.get(id) as { entry: Array<{ resource: { resourceType?: string } }> }).entry.map((entry) => entry.resource);
      assert.ok(resources.some((resource) => resource.resourceType === "Condition"), `${id} received enrollment evidence`);
    }
    const omittedResources = (seen.get("omitted-patient") as {
      entry: Array<{ resource: { resourceType?: string } }>;
    }).entry.map((entry) => entry.resource);
    assert.ok(
      omittedResources.every((resource) => resource.resourceType !== "Condition"),
      "explicit JSON omission remains unenrolled and is never broadened by the default policy",
    );
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("live preparation failure finalizes FAILED before outcomes and preserves the prior successful population", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  const audits: Array<{ eventType: string; payload: unknown }> = [];
  try {
    const base: RunPipelineDeps = {
      runStore,
      outcomeStore,
      engine: compliantEngine,
      employees: [],
      webChartEnv: WEBCHART_ENV,
      webChartClient: fixtureWebChartClient([patientOnly("last-good")]),
      events: { async appendAudit(input) { audits.push({ eventType: input.eventType, payload: input.payload }); } },
    };
    const success = await executeManualRun(base, { scopeType: "MEASURE", measureId: "audiogram" });
    const failingClient: WebChartClient = {
      kind: "failure-test",
      async fetchPatientPayloads() { throw new Error("population unavailable"); },
    };
    const failedPlan = await planManualRun({ ...base, webChartClient: failingClient }, { scopeType: "MEASURE", measureId: "audiogram" });
    await finishOrFail({ ...base, webChartClient: failingClient }, failedPlan);

    assert.equal((await runStore.getRun(failedPlan.run.id))?.status, "FAILED");
    assert.equal((await outcomeStore.listOutcomes(failedPlan.run.id)).length, 0, "preparation failure writes no new outcome");
    const latest = await outcomeStore.listLatestPopulationOutcomes({ measureId: "audiogram" });
    assert.ok(latest.length > 0 && latest.every((row) => row.runId === success.runId), "last successful population remains latest");
    const failedAudit = audits.find((audit) =>
      audit.eventType === "RUN_COMPLETED" &&
      (audit.payload as { liveTenant?: { status?: string } }).liveTenant?.status === "FAILED"
    );
    assert.ok(failedAudit, "failure terminal is audited with live-tenant metadata");
    const logs = await runStore.listLogs(failedPlan.run.id, 100);
    assert.ok(logs.some((log) => /population unavailable/.test(log.message)));
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("a page-2 population failure finalizes FAILED, writes no outcomes, and preserves the prior population and directory", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  try {
    const base: RunPipelineDeps = {
      runStore,
      outcomeStore,
      engine: compliantEngine,
      employees: [],
      webChartEnv: WEBCHART_ENV,
      webChartClient: fixtureWebChartClient([patientOnly("last-good-page-guard")]),
    };
    const success = await executeManualRun(base, { scopeType: "MEASURE", measureId: "audiogram" });
    assert.equal(profileForId("wc|last-good-page-guard")?.name, "Live last-good-page-guard");

    const pageTwoFailure: WebChartClient = {
      kind: "page-2-failure-test",
      async fetchPatientPayloads() {
        throw new Error("WebChart Patient page 2 failed after page 1");
      },
    };
    const failedDeps = { ...base, webChartClient: pageTwoFailure };
    const failedPlan = await planManualRun(failedDeps, { scopeType: "MEASURE", measureId: "audiogram" });
    await finishOrFail(failedDeps, failedPlan);

    assert.equal((await runStore.getRun(failedPlan.run.id))?.status, "FAILED");
    assert.equal((await outcomeStore.listOutcomes(failedPlan.run.id)).length, 0, "truncated fetch writes no new outcome");
    const latest = await outcomeStore.listLatestPopulationOutcomes({ measureId: "audiogram" });
    assert.ok(latest.length > 0 && latest.every((row) => row.runId === success.runId), "prior successful population stays latest");
    assert.equal(
      profileForId("wc|last-good-page-guard")?.name,
      "Live last-good-page-guard",
      "the last-known-good directory survives a partial-page failure",
    );
  } finally {
    replaceLiveDirectory([]);
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("synchronous configured execution finalizes FAILED before propagating a live preparation error", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  try {
    const failing: RunPipelineDeps = {
      runStore,
      outcomeStore,
      engine: compliantEngine,
      employees: [],
      webChartEnv: WEBCHART_ENV,
      webChartClient: {
        kind: "sync-preparation-failure-test",
        async fetchPatientPayloads() { throw new Error("sync population unavailable"); },
      },
    };

    await assert.rejects(
      executeManualRun(failing, { scopeType: "MEASURE", measureId: "audiogram" }),
      /sync population unavailable/,
    );

    const [run] = await runStore.listRuns(10);
    assert.equal(run?.status, "FAILED", "the no-waitUntil path never leaves the created run RUNNING");
    assert.equal((await outcomeStore.listOutcomes(run!.id)).length, 0);
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("a successful WebChart response with zero usable Patients fails before swapping the directory or writing outcomes", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  try {
    const base: RunPipelineDeps = {
      runStore,
      outcomeStore,
      engine: compliantEngine,
      employees: [],
      webChartEnv: WEBCHART_ENV,
      webChartClient: fixtureWebChartClient([patientOnly("last-good-empty-guard")]),
    };
    const success = await executeManualRun(base, { scopeType: "MEASURE", measureId: "audiogram" });
    assert.equal(profileForId("wc|last-good-empty-guard")?.name, "Live last-good-empty-guard");

    const emptyDeps = { ...base, webChartClient: fixtureWebChartClient([]) };
    const planned = await planManualRun(emptyDeps, { scopeType: "MEASURE", measureId: "audiogram" });
    await finishOrFail(emptyDeps, planned);

    assert.equal((await runStore.getRun(planned.run.id))?.status, "FAILED");
    assert.equal((await outcomeStore.listOutcomes(planned.run.id)).length, 0);
    assert.equal(
      profileForId("wc|last-good-empty-guard")?.name,
      "Live last-good-empty-guard",
      "the last-known-good directory survives an empty normalized population",
    );
    const latest = await outcomeStore.listLatestPopulationOutcomes({ measureId: "audiogram" });
    assert.ok(latest.length > 0 && latest.every((row) => row.runId === success.runId));
  } finally {
    replaceLiveDirectory([]);
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("invalid explicit enrollment JSON fails preparation without broadening enrollment", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  try {
    const invalid: RunPipelineDeps = {
      runStore,
      outcomeStore,
      engine: compliantEngine,
      employees: [],
      webChartEnv: { ...WEBCHART_ENV, WORKWELL_WEBCHART_ENROLLMENT_JSON: "{not-json" },
      webChartClient: fixtureWebChartClient([patientOnly("must-not-evaluate")]),
    };
    const planned = await planManualRun(invalid, { scopeType: "MEASURE", measureId: "audiogram" });
    await finishOrFail(invalid, planned);
    assert.equal((await runStore.getRun(planned.run.id))?.status, "FAILED");
    assert.equal((await outcomeStore.listOutcomes(planned.run.id)).length, 0);
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("a live preparation failure still finalizes FAILED when its terminal audit write rejects", async () => {
  const { p, runStore, outcomeStore } = await freshPipelineDb();
  try {
    const failing: RunPipelineDeps = {
      runStore,
      outcomeStore,
      engine: compliantEngine,
      employees: [],
      webChartEnv: WEBCHART_ENV,
      webChartClient: {
        kind: "failure-test",
        async fetchPatientPayloads() { throw new Error("population unavailable"); },
      },
      events: { async appendAudit() { throw new Error("audit unavailable"); } },
    };
    const planned = await planManualRun(failing, { scopeType: "MEASURE", measureId: "audiogram" });
    await finishOrFail(failing, planned);
    assert.equal((await runStore.getRun(planned.run.id))?.status, "FAILED");
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
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

test("live WebChart subjects are display-applicable but never open cases (Codex P2 #325)", async () => {
  // A wc| subject with a non-compliant outcome and NO segments (⇒ everyone applicable, the fresh-DB
  // demo state where the baseline now covers the WebChart site) must still create no case — because
  // rerun-to-verify returns 409 for wc| subjects, so a created case would be un-closeable.
  const liveEmployee = { ...employeeById("emp-005")!, externalId: "wc|live-overdue-1", tenantId: "wc", site: "WebChart" };
  const wcDeps: RunPipelineDeps = {
    ...deps,
    engine: overdueEngine,
    employees: [liveEmployee],
    segments: [], // zero enabled ⇒ display-applicable to everything (the contrast case created a case)
  };
  const res = await executeManualRun(wcDeps, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2095-05-05" });

  // The outcome is still persisted (CQL stays authoritative — ADR-008).
  const outcomes = await deps.outcomeStore.listOutcomes(res.runId);
  assert.equal(outcomes.length, 1, "the OVERDUE outcome is persisted");
  assert.equal(outcomes[0]!.subjectId, "wc|live-overdue-1");
  assert.equal(outcomes[0]!.status, "OVERDUE");

  // But NO case — the wc| guard skips case creation even though the subject is display-applicable.
  const cases = (await deps.caseStore!.listCases({})).filter(
    (c) => c.lastRunId === res.runId && c.employeeId === "wc|live-overdue-1",
  );
  assert.equal(cases.length, 0, "a live WebChart subject opens no case even when applicable");
});

test("an EXISTING WebChart case is still resolved by a COMPLIANT run (close-only runs for wc; Codex P2 #325)", async () => {
  // Simulate a wc case an owner opened earlier (e.g. by adding WebChart to an enabled group before
  // the create-guard existed): seed a non-compliant OVERDUE case directly, then a COMPLIANT run for the
  // same (subject, measure, period) must RESOLVE it — the create-guard must not strand it active,
  // since rerun-to-verify also 409s for wc|.
  const wcId = "wc|live-resolve-1";
  const wcEmp = { ...employeeById("emp-006")!, externalId: wcId, tenantId: "wc", site: "WebChart" };
  const period = "2094-06-06";
  // Seed the pre-existing OVERDUE case straight through the store (the owner-repair scenario).
  const seedRun = await executeManualRun(
    { ...deps, engine: overdueEngine, employees: [wcEmp], segments: [] },
    { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: period },
  );
  // The create-guard means the seed run itself opened no case — open one explicitly to model the
  // pre-existing-case state the guard must still be able to close.
  await deps.caseStore!.upsertFromOutcome({
    runId: seedRun.runId, subjectId: wcId, measureId: "audiogram",
    evaluationPeriod: bucketPeriodForMeasure("audiogram", period), outcomeStatus: "OVERDUE",
  });
  const openBefore = (await deps.caseStore!.listCases({})).filter(
    (c) => c.employeeId === wcId && c.measureId === "audiogram" && c.status !== "RESOLVED",
  );
  assert.equal(openBefore.length, 1, "precondition: an active wc case exists");

  // Now a COMPLIANT run for the same subject/period must close it (close-only bypass runs for wc).
  const res = await executeManualRun(
    { ...deps, engine: compliantEngine, employees: [wcEmp], segments: [] },
    { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: period },
  );
  const stillOpen = (await deps.caseStore!.listCases({})).filter(
    (c) => c.employeeId === wcId && c.measureId === "audiogram" && c.status !== "RESOLVED",
  );
  assert.equal(stillOpen.length, 0, "the existing wc case was resolved, not stranded active");
  assert.ok(res.status === "COMPLETED");
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
    const seedRun = await runStore.createRun({ scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed", requestedScope: {}, measurementPeriodStart: "2020-01-01T00:00:00.000Z", measurementPeriodEnd: "2020-12-31T00:00:00.000Z" });
    // A stale PRIOR-cycle OPEN case (2020) — should be rolled over.
    const stale = await caseStore.upsertFromOutcome({ runId: seedRun.id, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: "2020-01-01", outcomeStatus: "OVERDUE" });
    assert.equal(stale?.status, "OPEN");
    // A NEWER-cycle OPEN case (2099) — a backdated run at 2097 must NOT touch it (Codex P2: only older cycles).
    const future = await caseStore.upsertFromOutcome({ runId: seedRun.id, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: "2099-01-01", outcomeStatus: "OVERDUE" });
    assert.equal(future?.status, "OPEN");

    const d: RunPipelineDeps = { runStore, outcomeStore, caseStore, events, engine: overdueEngine, employees: [office], segments: [] };
    const res = await executeManualRun(d, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2097-03-03" });

    const closed = await caseStore.getCase(stale!.id);
    assert.equal(closed?.status, "RESOLVED", "the prior-cycle case is closed on the new run");
    assert.equal(closed?.closedReason, "CYCLE_ROLLED_OVER");
    assert.equal(closed?.closedBy, null, "system closure (not a human decision)");
    assert.equal((await caseStore.getCase(future!.id))?.status, "OPEN", "a newer-cycle case is NOT rolled over by an older run");
    const rolled = (await events.auditEventsByRun(res.runId)).filter(
      (a) => a.eventType === "CASE_RESOLVED" && (a.payload as { reason?: string })?.reason === "CYCLE_ROLLED_OVER",
    );
    assert.equal(rolled.length, 1, "exactly one (the prior-cycle) rollover close is audited");
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

test("Codex P2: an out-of-cohort EXCLUDED outcome with no existing case creates NO case (the gate holds)", async () => {
  const excludedEngine: RunPipelineDeps["engine"] = {
    async evaluate() {
      return { subjectId: "ignored", measure: "Audiogram", outcome: "EXCLUDED", evidence: { expressionResults: [{ define: "Outcome Status", result: "EXCLUDED" }] } };
    },
  };
  const { p, runStore, outcomeStore, caseStore, events } = await freshPipelineDb();
  const office = employeeById("emp-007")!; // out-of-cohort for the Welder audiogram segment
  try {
    const d: RunPipelineDeps = { runStore, outcomeStore, caseStore, events, engine: excludedEngine, employees: [office], segments: [welderSegment()] };
    const res = await executeManualRun(d, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2097-03-03" });
    // The EXCLUDED outcome is still persisted (ADR-008), but no case is inserted — with NO existing case,
    // EXCLUDED stays applicability-gated (it would otherwise CREATE an EXCLUDED case out-of-cohort).
    assert.equal((await outcomeStore.listOutcomes(res.runId)).length, 1);
    const mine = (await caseStore.listCases({})).filter((c) => c.employeeId === "emp-007" && c.measureId === "audiogram");
    assert.equal(mine.length, 0, "no EXCLUDED case is created for the out-of-cohort subject");
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("Codex P2: an out-of-cohort EXCLUDED outcome CLOSES an EXISTING active case (excuses it, creates none)", async () => {
  const excludedEngine: RunPipelineDeps["engine"] = {
    async evaluate() {
      return { subjectId: "ignored", measure: "Audiogram", outcome: "EXCLUDED", evidence: { expressionResults: [{ define: "Outcome Status", result: "EXCLUDED" }] } };
    },
  };
  const { p, runStore, outcomeStore, caseStore, events } = await freshPipelineDb();
  const office = employeeById("emp-007")!; // out-of-cohort for the Welder audiogram segment
  try {
    const period = bucketPeriodForMeasure("audiogram", "2097-03-03");
    const seedRun = await runStore.createRun({ scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed", requestedScope: {}, measurementPeriodStart: "2097-01-01T00:00:00.000Z", measurementPeriodEnd: "2097-12-31T00:00:00.000Z" });
    const open = await caseStore.upsertFromOutcome({ runId: seedRun.id, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: period, outcomeStatus: "OVERDUE" });
    assert.equal(open?.status, "OPEN");

    // A fresh waiver (EXCLUDED) on a now-out-of-cohort subject who already has an OPEN case for this cycle.
    const d: RunPipelineDeps = { runStore, outcomeStore, caseStore, events, engine: excludedEngine, employees: [office], segments: [welderSegment()] };
    await executeManualRun(d, { scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2097-03-03" });

    const after = await caseStore.getCase(open!.id);
    assert.equal(after?.status, "EXCLUDED", "the existing active case is excused even though the subject is out-of-cohort");
    // still no NEW case created — only the pre-existing one was transitioned.
    assert.equal((await caseStore.listCases({})).filter((c) => c.employeeId === "emp-007" && c.measureId === "audiogram").length, 1);
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});
