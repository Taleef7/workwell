/**
 * Integration test for the run→evaluate→persist slice (#104/#106): drives the
 * actual `handleRuns` route over a real @mieweb/cloud-local SQLite CloudDatabase —
 * create a run, evaluate a subject through the JVM-free CQL engine, persist + list
 * the outcome. No JVM, no server.
 *   node --import tsx --test src/routes/runs.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { handleRuns } from "./runs.ts";
import { EVALUABLE_EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { buildQrda1Document, qrda1NonConformance } from "../fhir/qrda1-export.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";

const dbPath = join(tmpdir(), `workwell-runs-route-${crypto.randomUUID()}.sqlite`);
const bundle = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../spike/synthetic/audiogram/present_recent.json", import.meta.url)), "utf8"),
);
let env: { DB: unknown };
const GENERATED_AT = "2026-07-15T20:30:00.000Z";

const post = (path: string, body?: unknown) =>
  handleRuns(new Request(`http://x${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }), env as never);
const get = (path: string) =>
  handleRuns(new Request(`http://x${path}`, { method: "GET" }), env as never, "system", undefined, GENERATED_AT);
/** POST that captures ctx.waitUntil background work so the async-scope path can be awaited deterministically. */
const postAsync = async (path: string, body?: unknown) => {
  const tasks: Promise<unknown>[] = [];
  const res = await handleRuns(
    new Request(`http://x${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
    env as never,
    "system",
    (p) => tasks.push(p),
  );
  return { res, drain: () => Promise.allSettled(tasks) };
};

before(async () => {
  env = { DB: await createSqliteD1(dbPath) };
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("create run → evaluate subject via engine → persist + list outcome", async () => {
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  assert.equal(created?.status, 201);
  const run = (await created!.json()) as { id: string };
  assert.ok(run.id);

  const evaluated = await post(`/api/runs/${run.id}/evaluate`, {
    measureId: "audiogram",
    patientBundle: bundle,
    evaluationDate: "2026-06-12",
  });
  assert.equal(evaluated?.status, 201);
  const outcome = (await evaluated!.json()) as { id: string; runId: string; status: string; measureId: string };
  assert.equal(outcome.runId, run.id);
  assert.equal(outcome.measureId, "audiogram");
  assert.equal(outcome.status, "COMPLIANT");

  const listed = await get(`/api/runs/${run.id}/outcomes`);
  assert.equal(listed?.status, 200);
  const rows = (await listed!.json()) as Array<{ outcomeStatus: string; employeeExternalId: string; caseId: string | null }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcomeStatus, "COMPLIANT"); // RunOutcomeRow shape
  assert.ok(rows[0]!.employeeExternalId, "row carries the employee external id");
  assert.equal(rows[0]!.caseId, null);

  // An evaluated run must not be re-handed to a worker (it left the QUEUED claim path).
  const claim = await post("/api/runs/claim");
  assert.equal(claim?.status, 204, "evaluated run is not re-claimed");

  // ---- read models (#107) -------------------------------------------------
  // List: the run appears with the RunListItem shape + computed counts.
  const list = await get("/api/runs");
  assert.equal(list?.status, 200);
  const rows2 = (await list!.json()) as Array<{ runId: string; measureName: string; totalEvaluated: number; compliantCount: number }>;
  const mine = rows2.find((r) => r.runId === run.id)!;
  assert.ok(mine, "created run is in the list");
  assert.equal(mine.measureName, "Audiogram");
  assert.equal(mine.totalEvaluated, 1);
  assert.equal(mine.compliantCount, 1);

  // Detail: RunSummary with passRate + outcomeCounts.
  const detail = await get(`/api/runs/${run.id}`);
  assert.equal(detail?.status, 200);
  const summary = (await detail!.json()) as { measureVersion: string; passRate: number; outcomeCounts: Array<{ status: string; count: number }>; totalCases: number };
  assert.equal(summary.measureVersion, "1.0.0");
  assert.equal(summary.passRate, 100); // the one subject is COMPLIANT
  assert.equal(summary.totalCases, 0);
  assert.deepEqual(summary.outcomeCounts, [{ status: "COMPLIANT", count: 1 }]);
});

test("evaluate without evaluationDate persists the engine's effective period (today / run's period), not blank", async () => {
  // No date in body, no period in the run → falls back to today (the engine default), not "".
  const r1 = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "t" });
  const run1 = (await r1!.json()) as { id: string };
  const e1 = await post(`/api/runs/${run1.id}/evaluate`, { measureId: "audiogram", patientBundle: bundle });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(((await e1!.json()) as { evaluationPeriod: string }).evaluationPeriod, today);

  // The run's persisted requestedScope.evaluationDate is preferred when the body omits it.
  const r2 = await post("/api/runs", {
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "t",
    requestedScope: { evaluationDate: "2025-01-15" },
  });
  const run2 = (await r2!.json()) as { id: string };
  const e2 = await post(`/api/runs/${run2.id}/evaluate`, { measureId: "audiogram", patientBundle: bundle });
  assert.equal(((await e2!.json()) as { evaluationPeriod: string }).evaluationPeriod, "2025-01-15");
});

test("evaluate refuses a terminal run (409) — a finished run's outcomes stay immutable (#233)", async () => {
  // Guards the read-model caches that key on runId (roster cell cache, scale memo): appending into a
  // COMPLETED run would keep its runId while changing its outcomes, so those caches would serve stale rows.
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };
  const runStore = new SqliteRunStore(env.DB as never);
  await runStore.markRunning(run.id); // QUEUED → RUNNING (finalizeRun requires QUEUED/RUNNING)
  await runStore.finalizeRun(run.id, "COMPLETED");

  const res = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram", patientBundle: bundle, evaluationDate: "2026-06-12" });
  assert.equal(res?.status, 409, "cannot evaluate into a terminal run");
  const body = (await res!.json()) as { error: string; status: string };
  assert.equal(body.error, "run_not_open");
  assert.equal(body.status, "COMPLETED");
  // and no outcome was appended
  const listed = await get(`/api/runs/${run.id}/outcomes`);
  assert.equal(((await listed!.json()) as unknown[]).length, 0, "terminal run gained no outcome");
});

test("run summary totalCases counts cases whose last_run_id is the run", async () => {
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };
  // upsert a case against this run (the cases table is ensured by handleRuns' floor DDL)
  await new SqliteCaseStore(env.DB as never).upsertFromOutcome({
    runId: run.id,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    outcomeStatus: "OVERDUE",
  });
  const summary = (await get(`/api/runs/${run.id}`).then((r) => r!.json())) as { totalCases: number };
  assert.equal(summary.totalCases, 1, "the open case is counted against its last run");
});

test("POST /api/runs/:id/rerun on a CASE run reruns the case (no 501)", async () => {
  // Seed a case + a persisted CASE-scope run carrying its caseId (as rerun-to-verify writes).
  const caseRow = (await new SqliteCaseStore(env.DB as never).upsertFromOutcome({
    runId: crypto.randomUUID(),
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    outcomeStatus: "OVERDUE",
  }))!;
  const caseRun = await post("/api/runs", {
    scopeType: "CASE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { caseId: caseRow.id, measureId: "audiogram", employeeExternalId: "emp-006", evaluationDate: "2026-06-13" },
  });
  const cr = (await caseRun!.json()) as { id: string };

  const res = await post(`/api/runs/${cr.id}/rerun`);
  assert.equal(res?.status, 201, "CASE rerun succeeds (was 501 before)");
  const body = (await res!.json()) as { scopeType: string; totalEvaluated: number; message: string };
  assert.equal(body.scopeType, "CASE");
  assert.equal(body.totalEvaluated, 1);
  assert.match(body.message, /rerun-to-verify/i);
});

test("POST /api/runs/manual SITE runs async: 201 RUNNING immediately, then completes in the background", async () => {
  // SITE/ALL_PROGRAMS share the async branch; SITE=HQ (4 employees) keeps the round-trip fast.
  // ALL_PROGRAMS correctness is covered in run-pipeline.test (injected population).
  const { res, drain } = await postAsync("/api/runs/manual", { scopeType: "SITE", site: "HQ", evaluationDate: "2097-03-03" });
  assert.equal(res?.status, 201);
  const body = (await res!.json()) as { runId: string; status: string; scopeLabel: string };
  assert.equal(body.status, "RUNNING", "returns immediately before the fan-out finishes");
  assert.equal(body.scopeLabel, "Site: HQ");

  await drain(); // run the ctx.waitUntil background work to completion
  const summary = (await get(`/api/runs/${body.runId}`).then((r) => r!.json())) as { status: string; totalEvaluated: number };
  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.totalEvaluated, 14 * 4, "14 runnable measures × 4 HQ employees evaluated in the background");
});

test("POST /api/runs/:id/rerun rejects a wc CASE branch with controlled 409", async () => {
  await get("/api/runs"); // initialize the floor schema when this test is selected in isolation
  const caseStore = new SqliteCaseStore(env.DB as never);
  const runStore = new SqliteRunStore(env.DB as never);
  const source = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-07-17T00:00:00.000Z", measurementPeriodEnd: "2026-07-17T23:59:59.999Z",
  });
  const wcCase = await caseStore.upsertFromOutcome({ runId: source.id, subjectId: "wc|runs-route-case", measureId: "audiogram", evaluationPeriod: "2026-01-01", outcomeStatus: "OVERDUE" });
  const prior = await runStore.createRun({
    scopeType: "CASE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { caseId: wcCase!.id, measureId: "audiogram", employeeExternalId: "wc|runs-route-case" },
    measurementPeriodStart: "2026-07-17T00:00:00.000Z", measurementPeriodEnd: "2026-07-17T23:59:59.999Z",
  });
  const beforeRuns = (await runStore.listRuns(1000)).length;

  const response = await post(`/api/runs/${prior.id}/rerun`);
  assert.equal(response?.status, 409);
  assert.deepEqual(await response!.json(), { error: "unsupported_scope", message: "Live WebChart CASE rerun-to-verify is not supported until fetch-one-patient is available." });
  assert.equal((await runStore.listRuns(1000)).length, beforeRuns);
});

test("GET /api/runs/:id/qrda1 scopes WebChart Patient reads to the run's subjects", async () => {
  await get("/api/runs");
  const runStore = new SqliteRunStore(env.DB as never);
  const outcomeStore = new SqliteOutcomeStore(env.DB as never);
  const run = await runStore.createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-07-17T00:00:00.000Z",
    measurementPeriodEnd: "2026-07-17T23:59:59.999Z",
    status: "COMPLETED",
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T23:59:59.999Z",
  });
  const subjects = ["wc|qrda-route-1", "wc|qrda-route-2", "wc|qrda-route-3"];
  await outcomeStore.recordOutcomes(
    subjects.map((subjectId) => ({
      runId: run.id,
      subjectId,
      measureId: "audiogram",
      evaluationPeriod: "2026-07-17",
      status: "COMPLIANT" as const,
      evidence: {},
    })),
  );

  const originalFetch = globalThis.fetch;
  const requestedPaths: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    requestedPaths.push(url.pathname + url.search);
    const patientRead = url.pathname.match(/^\/fhir\/Patient\/([^/]+)$/);
    if (patientRead) {
      return new Response(JSON.stringify({ resourceType: "Patient", id: decodeURIComponent(patientRead[1]!) }), {
        status: 200,
        headers: { "content-type": "application/fhir+json" },
      });
    }
    if (["Observation", "Condition", "Procedure", "Immunization", "Encounter"].some((type) => url.pathname === `/fhir/${type}`)) {
      return new Response(JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [], link: [] }), {
        status: 200,
        headers: { "content-type": "application/fhir+json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const response = await handleRuns(
      new Request(`http://x/api/runs/${run.id}/qrda1`, { method: "GET" }),
      { ...env, WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" } as never,
      "system",
      undefined,
      GENERATED_AT,
    );
    assert.equal(response?.status, 200);
    const patientReads = requestedPaths.filter((requestPath) => /^\/fhir\/Patient\/[^/?]+$/.test(requestPath)).sort();
    assert.deepEqual(patientReads, subjects.map((subjectId) => `/fhir/Patient/${subjectId.slice(3)}`).sort());
    assert.equal(requestedPaths.includes("/fhir/Patient"), false, "QRDA-I export must not crawl the population list");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("QRDA I export requests WebChart bundles only for the run's subjects", async () => {
  const originalFetch = globalThis.fetch;
  const subjectIds = ["wc|route-export-1", "wc|route-export-2", "wc|route-export-3"];
  const requestedPaths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    requestedPaths.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/fhir/Patient") {
      return new Response("whole-tenant population read is forbidden in this regression", { status: 500 });
    }
    if (url.pathname.startsWith("/fhir/Patient/")) {
      const id = decodeURIComponent(url.pathname.slice("/fhir/Patient/".length));
      return new Response(JSON.stringify({ resourceType: "Patient", id }), {
        status: 200,
        headers: { "content-type": "application/fhir+json" },
      });
    }
    if (url.pathname.startsWith("/fhir/") && url.searchParams.has("patient")) {
      return new Response(JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [], link: [] }), {
        status: 200,
        headers: { "content-type": "application/fhir+json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    await get("/api/runs"); // initialize the floor schema when this test is selected in isolation
    const runStore = new SqliteRunStore(env.DB as never);
    const outcomeStore = new SqliteOutcomeStore(env.DB as never);
    const run = await runStore.createRun({
      scopeType: "MEASURE",
      scopeId: "audiogram",
      triggeredBy: "test",
      requestedScope: { measureId: "audiogram" },
      measurementPeriodStart: "2026-07-31T00:00:00.000Z",
      measurementPeriodEnd: "2026-07-31T23:59:59.999Z",
    });
    await runStore.markRunning(run.id);
    for (const subjectId of subjectIds) {
      await outcomeStore.recordOutcome({
        runId: run.id,
        subjectId,
        measureId: "audiogram",
        evaluationPeriod: "2026-07-31",
        status: "MISSING_DATA",
        evidence: {},
      });
    }
    await runStore.finalizeRun(run.id, "COMPLETED");

    const response = await handleRuns(
      new Request(`http://x/api/runs/${run.id}/qrda1`, { method: "GET" }),
      {
        ...env,
        WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
        WORKWELL_WEBCHART_API_KEY: "fixture-key",
      } as never,
      "system",
      undefined,
      GENERATED_AT,
    );
    assert.equal(response?.status, 200);
    assert.deepEqual(
      requestedPaths.filter((path) => path.startsWith("/fhir/Patient/")).map((path) => path.slice("/fhir/Patient/".length)).sort(),
      subjectIds.map((id) => id.slice(3)).sort(),
    );
    assert.equal(requestedPaths.some((path) => path === "/fhir/Patient" || path.startsWith("/fhir/Patient?")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configured MEASURE schedules in waitUntil and returns 201 RUNNING before a blocked fetch settles", async () => {
  const originalFetch = globalThis.fetch;
  let release!: (response: Response) => void;
  let calls = 0;
  const blocked = new Promise<Response>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => {
    calls++;
    return blocked;
  }) as typeof fetch;
  const tasks: Promise<unknown>[] = [];
  try {
    const response = await Promise.race([
      handleRuns(
        new Request("http://x/api/runs/manual", {
          method: "POST",
          body: JSON.stringify({ scopeType: "MEASURE", measureId: "audiogram", evaluationDate: "2026-06-01" }),
        }),
        {
          ...env,
          WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
          WORKWELL_WEBCHART_API_KEY: "fixture-key",
        } as never,
        "system",
        (promise) => tasks.push(promise),
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("foreground response waited for WebChart")), 200)),
    ]);
    assert.equal(response?.status, 201);
    const body = (await response!.json()) as { status: string; totalEvaluated: number; message: string };
    assert.equal(body.status, "RUNNING");
    assert.equal(body.totalEvaluated, EVALUABLE_EMPLOYEES.length, "immediate count remains the known static EVALUABLE population (maui is directory-only)");
    assert.match(body.message, /live population count pending/i);
    assert.equal(tasks.length, 1);
    assert.equal(calls, 1, "background preparation started exactly one population fetch");

    release(new Response(JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [] }), {
      status: 200,
      headers: { "content-type": "application/fhir+json" },
    }));
    await Promise.allSettled(tasks);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configured SITE=WebChart is a controlled unsupported scope", async () => {
  const response = await handleRuns(
    new Request("http://x/api/runs/manual", {
      method: "POST",
      body: JSON.stringify({ scopeType: "SITE", site: "WebChart" }),
    }),
    {
      ...env,
      WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
      WORKWELL_WEBCHART_API_KEY: "fixture-key",
    } as never,
  );
  assert.equal(response?.status, 501);
  assert.equal(((await response!.json()) as { error: string }).error, "unsupported_scope");
});

test("an unknown scopeType is a malformed request (400), not an unimplemented scope (501)", async () => {
  // 501 means "this server knows the scope and does not serve it here" — true of CASE
  // (rerun-to-verify) and SITE=WebChart. A scopeType that is not a scope at all is a
  // client error: it must not read as a server-side gap.
  for (const scopeType of ["BANANA", "", "all_programs", 42, null]) {
    const res = await post("/api/runs/manual", { scopeType });
    assert.equal(res?.status, 400, `scopeType ${JSON.stringify(scopeType)} → 400`);
    const body = (await res!.json()) as { error: string; message: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.message, /scopeType/i);
  }
});

test("CASE stays a known-but-unsupported scope on the manual-run path (501)", async () => {
  const res = await post("/api/runs/manual", { scopeType: "CASE", caseId: crypto.randomUUID() });
  assert.equal(res?.status, 501);
  assert.equal(((await res!.json()) as { error: string }).error, "unsupported_scope");
});

test("configured wc EMPLOYEE scope returns non-mutating 409 before run creation", async () => {
  await get("/api/runs"); // initialize stores for isolated execution
  const runStore = new SqliteRunStore(env.DB as never);
  const outcomeStore = new SqliteOutcomeStore(env.DB as never);
  const eventStore = new SqliteCaseEventStore(env.DB as never);
  const beforeRuns = (await runStore.listRuns(1000)).length;
  const beforeOutcomes = (await outcomeStore.listOutcomesWithRun({})).length;
  const beforeAudits = (await eventStore.listAuditEvents()).length;

  const response = await handleRuns(
    new Request("http://x/api/runs/manual", {
      method: "POST",
      body: JSON.stringify({ scopeType: "EMPLOYEE", employeeExternalId: "wc|route-live-employee" }),
    }),
    {
      ...env,
      WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
      WORKWELL_WEBCHART_API_KEY: "fixture-key",
    } as never,
  );

  assert.equal(response?.status, 409);
  assert.equal(((await response!.json()) as { error: string }).error, "unsupported_scope");
  assert.equal((await runStore.listRuns(1000)).length, beforeRuns);
  assert.equal((await outcomeStore.listOutcomesWithRun({})).length, beforeOutcomes);
  assert.equal((await eventStore.listAuditEvents()).length, beforeAudits);
});

test("POST /api/runs/:id/rerun on a SITE run also goes async (RUNNING immediately, completes in background)", async () => {
  // Create a SITE run, then rerun it — the rerun must use the async waitUntil path too (a wide-scope
  // rerun carries the same fan-out), not block synchronously.
  const first = await postAsync("/api/runs/manual", { scopeType: "SITE", site: "HQ", evaluationDate: "2096-04-04" });
  const firstBody = (await first.res!.json()) as { runId: string };
  await first.drain();

  const rerun = await postAsync(`/api/runs/${firstBody.runId}/rerun`);
  assert.equal(rerun.res?.status, 201);
  const rerunBody = (await rerun.res!.json()) as { runId: string; status: string };
  assert.equal(rerunBody.status, "RUNNING", "wide-scope rerun returns immediately, not after the fan-out");
  assert.notEqual(rerunBody.runId, firstBody.runId, "rerun is a new run");
  await rerun.drain();
  const summary = (await get(`/api/runs/${rerunBody.runId}`).then((r) => r!.json())) as { status: string };
  assert.equal(summary.status, "COMPLETED");
});

test("POST /api/runs/manual maps invalid requests (unknown site → 400, missing measure → 400)", async () => {
  const badSite = await post("/api/runs/manual", { scopeType: "SITE", site: "Atlantis" });
  assert.equal(badSite?.status, 400);
  const invalid = await post("/api/runs/manual", { scopeType: "MEASURE" });
  assert.equal(invalid?.status, 400);
});

test("POST /api/runs/manual on a catalog-but-non-runnable (Draft) measure → 400 with an honest message", async () => {
  // cms2v15 is a Draft catalog entry (no compiled CQL) — the run picker lists all 60, but
  // only Active measures run (same as Java). The error must say so, not "Unknown measure".
  const res = await post("/api/runs/manual", { scopeType: "MEASURE", measureId: "cms2v15" });
  assert.equal(res?.status, 400);
  const body = (await res!.json()) as { message: string };
  assert.match(body.message, /not Active\/runnable/i);
  // a genuinely unknown id still reads as unknown
  const unknown = await post("/api/runs/manual", { scopeType: "MEASURE", measureId: "does-not-exist" });
  assert.match(((await unknown!.json()) as { message: string }).message, /Unknown measure/i);
});

test("GET /api/runs honors status/scopeType/site filters", async () => {
  const a = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "t", requestedScope: { site: "PLANT_A" } });
  const aRun = (await a!.json()) as { id: string };
  const b = await post("/api/runs", { scopeType: "ALL_PROGRAMS", triggeredBy: "t", requestedScope: {} });
  const bRun = (await b!.json()) as { id: string };

  const ids = async (qs: string) => ((await get(`/api/runs?${qs}`).then((r) => r!.json())) as Array<{ runId: string }>).map((x) => x.runId);

  assert.deepEqual(await ids("scopeType=ALL_PROGRAMS"), [bRun.id]);
  assert.deepEqual(await ids("site=PLANT_A"), [aRun.id]);
  assert.equal((await ids("site=PLANT_Z")).length, 0, "an unmatched site filters all out (not ignored)");
  // both are QUEUED (not evaluated), so a QUEUED status filter returns both
  assert.equal((await ids("status=QUEUED")).filter((id) => id === aRun.id || id === bRun.id).length, 2);
  assert.equal(
    (await ids("status=FAILED")).filter((id) => id === aRun.id || id === bRun.id).length,
    0,
    "the two runs created by this test are not FAILED",
  );
});

test("GET /api/runs/:id/logs returns the run's log timeline; unknown run detail → 404", async () => {
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };

  const logs = await get(`/api/runs/${run.id}/logs`);
  assert.equal(logs?.status, 200);
  assert.ok(Array.isArray(await logs!.json()));

  const missing = await get(`/api/runs/${crypto.randomUUID()}`);
  assert.equal(missing?.status, 404);
});

test("evaluate against an unknown run → 404", async () => {
  const res = await post(`/api/runs/${crypto.randomUUID()}/evaluate`, { measureId: "audiogram", patientBundle: bundle });
  assert.equal(res?.status, 404);
});

test("evaluate with a missing body → 400", async () => {
  const created = await post("/api/runs", { scopeType: "MEASURE" });
  const run = (await created!.json()) as { id: string };
  const res = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram" });
  assert.equal(res?.status, 400);
});

test("GET /api/runs/:id/measure-report → summary reconciles with outcomes; 404/bundle", async () => {
  const created = (await (await post("/api/runs/manual", { scopeType: "MEASURE", measureId: "audiogram" }))!.json()) as { runId?: string; id?: string };
  const runId = created.runId ?? created.id;

  const sumRes = (await get(`/api/runs/${runId}/measure-report`))!; // default type=summary
  assert.equal(sumRes.status, 200);
  assert.equal(sumRes.headers.get("content-type"), "application/fhir+json");
  const mr = (await sumRes.json()) as {
    resourceType: string;
    id: string;
    date: string;
    reporter: { reference: string };
    contained: Array<{ resourceType: string; id: string; name: string }>;
    type: string;
    group: Array<{ population: Array<{ code: { coding: Array<{ code: string }> }; count: number }> }>;
  };
  assert.equal(mr.resourceType, "MeasureReport");
  assert.equal(mr.type, "summary");
  assert.match(mr.id, /^[0-9a-f-]{36}$/);
  assert.equal(mr.date, GENERATED_AT, "MeasureReport.date is the injected report-generation time");
  assert.equal(mr.reporter.reference, "#workwell-measure-studio");
  assert.equal(mr.contained[0]?.name, "WorkWell Measure Studio");

  const rows = (await (await get(`/api/runs/${runId}/outcomes`))!.json()) as Array<{ outcomeStatus: string }>;
  const total = rows.length;
  // /api/runs/:id/outcomes returns RunOutcomeRow (outcomeStatus field, not status)
  const excluded = rows.filter((r) => r.outcomeStatus === "EXCLUDED").length;
  const compliant = rows.filter((r) => r.outcomeStatus === "COMPLIANT").length;
  const popCount = (code: string): number => {
    const p = mr.group[0]!.population.find((x) => x.code.coding[0]?.code === code);
    assert.ok(p, `population ${code} not found`);
    return p!.count;
  };
  assert.equal(popCount("initial-population"), total);
  assert.equal(popCount("denominator-exclusion"), excluded);
  assert.equal(popCount("denominator"), total);
  assert.equal(popCount("numerator"), compliant);

  const bundle = (await (await get(`/api/runs/${runId}/measure-report?type=bundle`))!.json()) as {
    resourceType: string;
    entry: Array<{ fullUrl: string; resource: { id: string } }>;
  };
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.entry.length, 1 + total);
  for (const entry of bundle.entry) assert.equal(entry.fullUrl, `urn:uuid:${entry.resource.id}`);

  // type=individual is a synonym for the collection bundle (it carries the per-subject individuals).
  const indiv = (await (await get(`/api/runs/${runId}/measure-report?type=individual`))!.json()) as { resourceType: string };
  assert.equal(indiv.resourceType, "Bundle");

  assert.equal((await get(`/api/runs/${runId}/measure-report?type=bogus`))!.status, 400);
  assert.equal((await get(`/api/runs/${crypto.randomUUID()}/measure-report`))!.status, 404);
});

test("GET /api/runs/:id/outcomes → whole run by default, X-Total-Count + explicit paging (Fable H4 / Codex P2)", async () => {
  const created = (await (await post("/api/runs/manual", { scopeType: "MEASURE", measureId: "audiogram" }))!.json()) as { runId?: string; id?: string };
  const runId = created.runId ?? created.id;

  // Codex P2: a normal run is NOT truncated by default — the /runs grid renders the array directly
  // without paging, so the default must return every row (X-Total-Count == returned length).
  const full = (await get(`/api/runs/${runId}/outcomes`))!;
  const rows = (await full.json()) as unknown[];
  const total = Number(full.headers.get("X-Total-Count"));
  assert.ok(total >= 2, "the manual MEASURE run produced at least 2 outcomes");
  assert.equal(rows.length, total, "default returns the whole run (no 500-row truncation)");

  const page = (await get(`/api/runs/${runId}/outcomes?limit=1&offset=0`))!;
  assert.equal(((await page.json()) as unknown[]).length, 1, "explicit limit pages");
  assert.equal(page.headers.get("X-Total-Count"), String(total), "X-Total-Count is the full count, not the page size");

  const beyond = (await get(`/api/runs/${runId}/outcomes?limit=5&offset=${total}`))!;
  assert.equal(((await beyond.json()) as unknown[]).length, 0, "offset past the end → empty page");
});

test("GET /api/runs/:id/measure-report → 422 for a multi-measure (ALL_PROGRAMS) run", async () => {
  const { res, drain } = await postAsync("/api/runs/manual", { scopeType: "ALL_PROGRAMS" });
  await drain(); // let the async ctx.waitUntil task persist outcomes across all measures
  const created = (await res!.json()) as { runId?: string; id?: string };
  const runId = created.runId ?? created.id;
  const r = (await get(`/api/runs/${runId}/measure-report`))!;
  assert.equal(r.status, 422);
  const body = (await r.json()) as { error: string };
  assert.equal(body.error, "unsupported_run_scope");
});

test("GET /api/runs/:id/qrda → well-formed QRDA III XML; 404 unknown run", async () => {
  const created = await (await post("/api/runs/manual", { scopeType: "MEASURE", measureId: "audiogram" }))!.json();
  const runId = (created as { runId?: string; id?: string }).runId ?? (created as { runId?: string; id?: string }).id;
  const res = (await get(`/api/runs/${runId}/qrda?format=xml`))!;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/xml");
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="qrda3-.*\.xml"/);
  const xml = await res.text();
  assert.ok(xml.startsWith("<?xml"));
  assert.ok(xml.includes('root="2.16.840.1.113883.10.20.27.1.1"'), "QRDA III templateId");
  assert.ok(xml.includes('extension="audiogram"'), "measure reference");
  assert.equal((await get(`/api/runs/${crypto.randomUUID()}/qrda`))!.status, 404);
});

test("Codex P2: a non-string triggeredBy is coerced to 'manual', never a 500", async () => {
  // Untrusted body: `{"triggeredBy":123}` must not throw `raw.trim is not a function`.
  const res = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: 123 });
  assert.equal(res?.status, 201);
  assert.equal(((await res!.json()) as { triggeredBy: string }).triggeredBy, "manual");
  // and a forged reserved label is still coerced (Fable M1)
  const seed = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed:scale" });
  assert.equal(((await seed!.json()) as { triggeredBy: string }).triggeredBy, "manual");
});

test("POST /api/runs/:id/evaluate accepts a QRDA I document — §170.315(c)(2) import AND calculate", async () => {
  // The whole point of Category I carrying patient DATA rather than an answer (ADR-050): a receiver
  // recalculates from it. This drives the real route end to end — export the bundle the engine just
  // evaluated, feed the DOCUMENT back in, and require the same outcome. Importing is a mapping into the
  // unchanged engine, not a second calculator (ADR-051).
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };

  const direct = await post(`/api/runs/${run.id}/evaluate`, {
    measureId: "audiogram",
    patientBundle: bundle,
    evaluationDate: "2026-06-12",
  });
  const fromBundle = (await direct!.json()) as { status: string; subjectId: string };

  const runRecord = {
    id: run.id,
    measurementPeriodStart: "2025-06-12T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  } as never;
  // A REAL-terminology bundle. The audiogram fixture binds synthetic `urn:workwell:vs:*` value sets,
  // which have no CDA code system OID, so a QRDA cannot carry them at all — the export says so, and the
  // next test pins that. QRDA I is only a meaningful artifact for data in real terminology.
  const realCoded = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: fromBundle.subjectId } },
      {
        resource: {
          resourceType: "Procedure",
          id: "audio-1",
          status: "completed",
          code: { coding: [{ system: "http://snomed.info/sct", code: "77862003", display: "Audiometry" }] },
          performedDateTime: "2026-03-01T09:00:00Z",
        },
      },
    ],
  };
  const document = buildQrda1Document(
    runRecord,
    "audiogram",
    { subjectId: fromBundle.subjectId, measureId: "audiogram", evidence: {} } as never,
    realCoded,
  );

  const roundTripped = await post(`/api/runs/${run.id}/evaluate`, {
    measureId: "audiogram",
    qrda1: document,
    evaluationDate: "2026-06-12",
  });
  assert.equal(roundTripped?.status, 201);
  const fromDocument = (await roundTripped!.json()) as {
    status: string;
    subjectId: string;
    qrda1?: { untranslatedTemplates: string[] };
  };
  assert.equal(fromDocument.subjectId, fromBundle.subjectId, "the same subject the document names");
  // What the import could not translate travels with the answer — silence would let a partial import
  // read as a full one (the CMS RY2026 sample alone carries 47 such entries).
  assert.deepEqual(fromDocument.qrda1?.untranslatedTemplates, []);
});

test("POST /api/runs/:id/evaluate REFUSES an unreadable QRDA I with the reason, never a silent empty bundle", async () => {
  // An empty bundle evaluates out-of-population for every measure — indistinguishable from a genuinely
  // ineligible patient, which is the hazard ADR-043 exists for.
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };
  for (const [payload, expected] of [
    ["<html>not cda</html>", /not a CDA document/],
    [`<ClinicalDocument xmlns="urn:hl7-org:v3"/>`, /no Patient Data Section/],
  ] as const) {
    const res = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram", qrda1: payload });
    assert.equal(res?.status, 400);
    const body = (await res!.json()) as { error: string; message: string };
    assert.equal(body.error, "qrda1_import_failed");
    assert.match(body.message, expected);
  }
  // A non-string qrda1 is a request error, not a 500.
  const wrongType = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram", qrda1: 42 });
  assert.equal(wrongType?.status, 400);
  assert.equal(((await wrongType!.json()) as { error: string }).error, "invalid_request");
});

test("a QRDA I export SAYS WHY nothing translated, rather than only that it is empty", async () => {
  // Found by the import round trip, and it is a structural limit rather than a bug: WorkWell's authored
  // measures bind synthetic `urn:workwell:vs:*` value sets, which have no CDA code system OID, so a QRDA
  // cannot carry their data at all. Reporting only "no QDM patient data entries" for a bundle that was
  // present and full of resources is the misleading half of the truth.
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };
  const reasons = qrda1NonConformance(
    { subjectId: "s", measureId: "audiogram", evidence: {} } as never,
    "audiogram",
    bundle,
  );
  assert.ok(reasons.some((r) => /no QDM patient data entries/.test(r)), "still says it is not conformant");
  assert.ok(
    reasons.some((r) => /no CDA code system OID for urn:workwell:vs:/.test(r)),
    `and names the cause — got ${JSON.stringify(reasons)}`,
  );
  assert.ok(run.id);
});

test("POST evaluate REFUSES a QRDA I whose measure is not the one requested (Codex, #362)", async () => {
  // A CMS125 document posted with measureId "cms122" was calculated AND PERSISTED as cms122 — a silent
  // mislabel of a regulatory artifact. The document says which measure it is about; honour it.
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };
  const runRecord = { id: run.id, measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z" } as never;
  const realCoded = {
    resourceType: "Bundle", type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "emp-006" } },
      { resource: { resourceType: "Procedure", id: "p1", status: "completed", code: { coding: [{ system: "http://snomed.info/sct", code: "77862003" }] }, performedDateTime: "2026-03-01T09:00:00Z" } },
    ],
  };
  // The document names `audiogram` (WorkWell's urn — the measure is authored, so no eMeasure UUID).
  const document = buildQrda1Document(runRecord, "audiogram", { subjectId: "emp-006", measureId: "audiogram", evidence: {} } as never, realCoded);

  const mismatched = await post(`/api/runs/${run.id}/evaluate`, { measureId: "cms122", qrda1: document });
  assert.equal(mismatched?.status, 400);
  const body = (await mismatched!.json()) as { error: string; documentReferences: string[] };
  assert.equal(body.error, "qrda1_measure_mismatch");
  assert.deepEqual(body.documentReferences, ["audiogram"]);

  // The matching request still works — the guard must not refuse the correct case.
  const matched = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram", qrda1: document });
  assert.equal(matched?.status, 201, "the guard must not block the measure the document names");
});

test("import gaps are PERSISTED in the outcome evidence, not only in the POST response (Codex, #362)", async () => {
  // Returning `untranslatedTemplates` only in the immediate response meant every later read — outcomes,
  // MeasureReport, QRDA — presented a partial calculation as an ordinary one, and the qualification died
  // with the request.
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };
  const runRecord = { id: run.id, measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z" } as never;
  const realCoded = {
    resourceType: "Bundle", type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "emp-006" } },
      { resource: { resourceType: "Procedure", id: "p1", status: "completed", code: { coding: [{ system: "http://snomed.info/sct", code: "77862003" }] }, performedDateTime: "2026-03-01T09:00:00Z" } },
    ],
  };
  const document = buildQrda1Document(runRecord, "audiogram", { subjectId: "emp-006", measureId: "audiogram", evidence: {} } as never, realCoded);
  const res = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram", qrda1: document });
  assert.equal(res?.status, 201);
  const outcome = (await res!.json()) as { evidence: { qrda1Import?: { untranslatedTemplates: string[]; measureReferences: string[] } } };
  assert.ok(outcome.evidence.qrda1Import, "the import qualification is part of the stored evidence");
  assert.deepEqual(outcome.evidence.qrda1Import!.untranslatedTemplates, []);
  // A bundle-supplied evaluation carries no such key — the qualification is only claimed when earned.
  const plain = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram", patientBundle: bundle, evaluationDate: "2026-06-12" });
  const plainOutcome = (await plain!.json()) as { evidence: Record<string, unknown> };
  assert.equal(plainOutcome.evidence.qrda1Import, undefined);
});

// ---------------------------------------------------------------- batch import + finalize (M-B / C2)

/**
 * A run CREATED for imported documents. Both new routes require it: inferring import-drivenness from the
 * rows was defeated by the window in which a population run is RUNNING with no outcomes yet, which let a
 * QRDA III be exported from a run that went on to gain 2,100 more outcomes (review, #389).
 */
const importRun = {
  scopeType: "MEASURE",
  scopeId: "audiogram",
  triggeredBy: "test",
  requestedScope: { measureId: "audiogram", importDriven: true },
};

/** A minimal QRDA I for the audiogram measure's shape — one Encounter, so the import does not refuse it. */
const importableDocument = (mrn: string, mbi?: string, encounterId = "enc-1") => `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole>
    <id extension="${mrn}" root="1.3.6.1.4.1.115"/>
    ${mbi ? `<id extension="${mbi}" root="2.16.840.1.113883.4.927"/>` : ""}
    <patient>
      <name><given>ADA</given><family>Lovelace</family></name>
      <administrativeGenderCode nullFlavor="OTH"><translation code="248152002" codeSystem="2.16.840.1.113883.6.96"/></administrativeGenderCode>
      <birthTime value='19781224203000'/>
    </patient>
  </patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId extension="2021-08-01" root="2.16.840.1.113883.10.20.24.3.23"/>
      <id extension="${encounterId}" root="1.3.6.1.4.1.115"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <statusCode code="completed"/>
      <effectiveTime><low value='20260331080000'/><high value='20260331081500'/></effectiveTime>
    </encounter></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

test("import → finalize → export: a batch of documents becomes a reportable run", async () => {
  // The whole §170.315(c)(2) loop over the API, which is what a Cypress C2 submission needs and what no
  // route could do before: `GET /api/runs/:id/qrda` refuses a RUNNING run (correctly — exporting a run
  // that is still writing outcomes presents a partial roster as complete) and NOTHING finalized an
  // imported run, so the loop stopped one step short of a document to submit.
  const created = await post("/api/runs", importRun);
  const run = (await created!.json()) as { id: string };

  // Three documents, two people: the first two share a Medicare Beneficiary Identifier the way a
  // clinically split patient does, and the third shares nothing.
  const imported = await post(`/api/runs/${run.id}/import`, {
    measureId: "audiogram",
    evaluationDate: "2026-06-12",
    qrda1: [
      importableDocument("mrn-a", "MBI-1", "e1"),
      importableDocument("mrn-b", "MBI-1", "e2"),
      importableDocument("mrn-c", undefined, "e3"),
    ],
  });
  assert.equal(imported?.status, 201);
  const result = (await imported!.json()) as {
    documents: number;
    subjects: number;
    outcomes: Array<{ subjectId: string }>;
    merged: Array<{ subjectId: string; documentIndexes: number[] }>;
  };
  assert.equal(result.documents, 3);
  assert.equal(result.subjects, 2, "documents are resolved to PEOPLE before evaluation");
  assert.equal(result.outcomes.length, 2, "one outcome per person, not per document");
  assert.deepEqual(result.merged[0]!.documentIndexes, [0, 1]);

  const finalized = await post(`/api/runs/${run.id}/finalize`);
  assert.equal(finalized?.status, 200);
  assert.equal(((await finalized!.json()) as { status: string }).status, "COMPLETED");

  // And now — only now — the run is reportable.
  const qrda = await get(`/api/runs/${run.id}/qrda`);
  assert.equal(qrda?.status, 200, "the export that returns 409 for a RUNNING run now succeeds");
  assert.match(await qrda!.text(), /<ClinicalDocument/);
});

test("finalize REFUSES a run whose outcomes did not come from imported documents", async () => {
  // The load-bearing guard. A population run is advanced by the pipeline, which knows when its fan-out
  // is done; finalizing one from outside would mark a partial roster COMPLETED and make it exportable —
  // the exact harm `notReportable` exists to prevent. Checked without new state: an imported outcome
  // carries `qrda1Import` evidence and a pipeline one does not.
  const created = await post("/api/runs", importRun);
  const run = (await created!.json()) as { id: string };
  const evaluated = await post(`/api/runs/${run.id}/evaluate`, {
    measureId: "audiogram",
    patientBundle: bundle,
    evaluationDate: "2026-06-12",
  });
  assert.equal(evaluated?.status, 201);

  const finalized = await post(`/api/runs/${run.id}/finalize`);
  assert.equal(finalized?.status, 409);
  const body = (await finalized!.json()) as { error: string; message: string };
  assert.equal(body.error, "run_not_import_driven");
  assert.match(body.message, /1 of 1/);
});

test("finalize REFUSES a run with no outcomes rather than reporting an empty roster", async () => {
  const created = await post("/api/runs", importRun);
  const run = (await created!.json()) as { id: string };
  const finalized = await post(`/api/runs/${run.id}/finalize`);
  assert.equal(finalized?.status, 409);
  assert.equal(((await finalized!.json()) as { error: string }).error, "run_has_no_outcomes");
});

test("finalize is not a second chance — a finished run is refused, not re-finalized", async () => {
  const created = await post("/api/runs", importRun);
  const run = (await created!.json()) as { id: string };
  await post(`/api/runs/${run.id}/import`, {
    measureId: "audiogram",
    evaluationDate: "2026-06-12",
    qrda1: [importableDocument("mrn-solo", "MBI-SOLO")],
  });
  assert.equal((await post(`/api/runs/${run.id}/finalize`))?.status, 200);
  const again = await post(`/api/runs/${run.id}/finalize`);
  assert.equal(again?.status, 409);
  assert.equal(((await again!.json()) as { error: string }).error, "run_already_finished");
});

test("import REFUSES a submission it cannot read at all, instead of reporting an empty population", async () => {
  // Reporting 0 subjects with a 201 is the empty-bundle hazard by another route: it reads as "nobody
  // qualifies" when the truth is "we could not read anything you sent" (ADR-043).
  const created = await post("/api/runs", importRun);
  const run = (await created!.json()) as { id: string };
  const imported = await post(`/api/runs/${run.id}/import`, { measureId: "audiogram", qrda1: ["<nope/>", "<also-nope/>"] });
  assert.equal(imported?.status, 400);
  const body = (await imported!.json()) as { error: string; failures: Array<{ index: number }> };
  assert.equal(body.error, "qrda1_import_failed");
  assert.deepEqual(body.failures.map((f) => f.index), [0, 1], "each unreadable document is named by index");
});

test("import REFUSES a submission about a different measure", async () => {
  // A CMS125 submission posted as cms122 would be calculated AND PERSISTED as cms122 (Codex, #362).
  // Checked once across the batch rather than per document.
  const created = await post("/api/runs", importRun);
  const run = (await created!.json()) as { id: string };
  const withMeasureSection = importableDocument("mrn-x", "MBI-X").replace(
    "</section></component></structuredBody></component>",
    `</section></component><component><section>
       <templateId root="2.16.840.1.113883.10.20.24.2.2" extension="2021-08-01"/>
       <entry><organizer classCode="CLUSTER" moodCode="EVN"><reference typeCode="REFR"><externalDocument classCode="DOC" moodCode="EVN">
         <id root="2.16.840.1.113883.4.738" extension="not-this-measure"/>
       </externalDocument></reference></organizer></entry>
     </section></component></structuredBody></component>`,
  );
  const imported = await post(`/api/runs/${run.id}/import`, { measureId: "audiogram", qrda1: [withMeasureSection] });
  assert.equal(imported?.status, 400);
  assert.equal(((await imported!.json()) as { error: string }).error, "qrda1_measure_mismatch");
});

test("import and finalize REFUSE a run that was not created for imported documents", async () => {
  // The critical guard. `scheduleAsyncRun` returns RUNNING immediately and finishes its fan-out in the
  // background, so a population run spends a window RUNNING with ZERO outcomes — during which "every
  // outcome carries qrda1Import" is vacuously true. Review (#389) drove exactly that: one document
  // imported into an ALL_PROGRAMS run, finalized COMPLETED, a QRDA III exported, and the run then gained
  // 2,100 more outcomes. Import-drivenness is therefore a property of CONSTRUCTION, which a run the
  // pipeline owns can never acquire.
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };

  const imported = await post(`/api/runs/${run.id}/import`, {
    measureId: "audiogram",
    qrda1: [importableDocument("mrn-guard", "MBI-GUARD")],
  });
  assert.equal(imported?.status, 409);
  assert.equal(((await imported!.json()) as { error: string }).error, "run_not_import_driven");

  const finalized = await post(`/api/runs/${run.id}/finalize`);
  assert.equal(finalized?.status, 409);
  assert.equal(((await finalized!.json()) as { error: string }).error, "run_not_import_driven");
});

test("a subject the engine cannot evaluate is PERSISTED, and the run finalizes PARTIAL_FAILURE", async () => {
  // Collecting the failure in the response only loses the subject when the request ends: no row, no log,
  // no audit, and the exported report counts a roster short with nothing saying so. It also made the
  // PARTIAL_FAILURE branch structurally dead, since every row `/finalize` could see came from a
  // SUCCESSFUL evaluate (review, #389). One fix, both halves — so this test pins both.
  const created = await post("/api/runs", importRun);
  const run = (await created!.json()) as { id: string };
  const imported = await post(`/api/runs/${run.id}/import`, {
    // A measure the engine cannot evaluate: every subject throws.
    measureId: "no-such-measure-at-all",
    qrda1: [importableDocument("mrn-f1", "MBI-F1"), importableDocument("mrn-f2", "MBI-F2")],
  });
  assert.equal(imported?.status, 201);
  const body = (await imported!.json()) as { subjects: number; outcomes: unknown[]; evaluationFailures: unknown[] };
  assert.equal(body.subjects, 2);
  assert.equal(body.evaluationFailures.length, 2);
  assert.equal(body.outcomes.length, 2, "a failed subject still has a row — the roster is complete");

  // The persisted ROWS, not the read model: `/outcomes` renders `RunOutcomeRow`, whose status field is
  // named differently and which does not carry evidence at all.
  const rows = await new SqliteOutcomeStore(env.DB as never).listOutcomes(run.id);
  assert.deepEqual(rows.map((r) => r.status), ["MISSING_DATA", "MISSING_DATA"]);
  const evidenceOf = (r: (typeof rows)[number]) => r.evidence as { evaluationError?: string; qrda1Import?: unknown };
  assert.ok(rows.every((r) => evidenceOf(r).evaluationError), "the reason is on the row, not just in the response");
  assert.ok(rows.every((r) => evidenceOf(r).qrda1Import), "and it is still an imported outcome");

  const finalized = await post(`/api/runs/${run.id}/finalize`);
  assert.equal(finalized?.status, 200);
  assert.equal(((await finalized!.json()) as { status: string }).status, "PARTIAL_FAILURE");
});

test("a cross-lineage measure identity is admitted only when ASSERTED, and the claim is recorded", async () => {
  // The load-bearing path for a real Cypress submission — its documents carry the QDM eMeasure UUID of a
  // measure we hold as FHIR — and it had no test at all (review, #389). Both halves: the assertion
  // admits the batch, and it lands in the outcome's evidence so a reader sees a human's claim.
  const foreign = "DBD9ECCD-C3EA-42DB-9344-72AD44F84F51";
  const document = importableDocument("mrn-lineage", "MBI-LINEAGE").replace(
    "</section></component></structuredBody></component>",
    `</section></component><component><section>
       <templateId root="2.16.840.1.113883.10.20.24.2.2" extension="2021-08-01"/>
       <entry><organizer classCode="CLUSTER" moodCode="EVN"><reference typeCode="REFR"><externalDocument classCode="DOC" moodCode="EVN">
         <id root="2.16.840.1.113883.4.738" extension="${foreign}"/>
       </externalDocument></reference></organizer></entry>
     </section></component></structuredBody></component>`,
  );
  const runA = (await (await post("/api/runs", importRun))!.json()) as { id: string };
  const refused = await post(`/api/runs/${runA.id}/import`, { measureId: "audiogram", qrda1: [document] });
  assert.equal(refused?.status, 400, "refusing is the default");

  const runB = (await (await post("/api/runs", importRun))!.json()) as { id: string };
  const admitted = await post(`/api/runs/${runB.id}/import`, {
    measureId: "audiogram",
    qrda1: [document],
    assertMeasureIdentifiers: [foreign],
  });
  assert.equal(admitted?.status, 201);
  const rows = await new SqliteOutcomeStore(env.DB as never).listOutcomes(runB.id);
  const provenance = (rows[0]!.evidence as { qrda1Import?: { assertedMeasureIdentifiers?: string[] } }).qrda1Import;
  assert.deepEqual(provenance?.assertedMeasureIdentifiers, [foreign]);
});

test("ONE document about another measure fails the whole batch — the check is per subject", async () => {
  // Checking the UNION means one matching document licenses the batch: 149 CMS125 documents plus one
  // CMS122 would pass, and that document's data would be merged, evaluated and PERSISTED as the wrong
  // measure — the silent mislabel #362 refused, reintroduced by aggregating (review, #389).
  const stranger = importableDocument("mrn-stranger", "MBI-STRANGER").replace(
    "</section></component></structuredBody></component>",
    `</section></component><component><section>
       <templateId root="2.16.840.1.113883.10.20.24.2.2" extension="2021-08-01"/>
       <entry><organizer classCode="CLUSTER" moodCode="EVN"><reference typeCode="REFR"><externalDocument classCode="DOC" moodCode="EVN">
         <id root="2.16.840.1.113883.4.738" extension="a-different-measure"/>
       </externalDocument></reference></organizer></entry>
     </section></component></structuredBody></component>`,
  );
  const run = (await (await post("/api/runs", importRun))!.json()) as { id: string };
  const imported = await post(`/api/runs/${run.id}/import`, {
    measureId: "audiogram",
    qrda1: [importableDocument("mrn-ok", "MBI-OK"), stranger],
  });
  assert.equal(imported?.status, 400);
  const body = (await imported!.json()) as { error: string; message: string; documentIndexes: number[] };
  assert.equal(body.error, "qrda1_measure_mismatch");
  assert.match(body.message, /1 of 2 subject/);
  assert.deepEqual(body.documentIndexes, [1], "and it names WHICH document");
});

test("finalize writes an audit event — a run state change with no ledger entry is a hard-rule breach", async () => {
  const run = (await (await post("/api/runs", importRun))!.json()) as { id: string };
  await post(`/api/runs/${run.id}/import`, {
    measureId: "audiogram",
    evaluationDate: "2026-06-12",
    qrda1: [importableDocument("mrn-audit", "MBI-AUDIT")],
  });
  await post(`/api/runs/${run.id}/finalize`);
  const events = new SqliteCaseEventStore(env.DB as never);
  const audited = (await events.recentAuditEventsByType("RUN_COMPLETED", 50)).filter((e) => e.refRunId === run.id);
  assert.equal(audited.length, 1, "the pipeline audits its terminal state; so must this route");
});

test("a run takes ONE submission — a retried import cannot double the population", async () => {
  // `outcomes` has no unique key on (run_id, subject_id, measure, period), so a client retrying after a
  // timeout would insert a second row per subject and double what the QRDA III states, with /finalize
  // accepting every row as imported (Codex, #389). Refusing beats upserting: a retry is
  // indistinguishable from a deliberate second archive, and silently merging two into one report is the
  // worse mistake.
  const run = (await (await post("/api/runs", importRun))!.json()) as { id: string };
  const documents = { measureId: "audiogram", evaluationDate: "2026-06-12", qrda1: [importableDocument("mrn-once", "MBI-ONCE")] };
  assert.equal((await post(`/api/runs/${run.id}/import`, documents))?.status, 201);

  const again = await post(`/api/runs/${run.id}/import`, documents);
  assert.equal(again?.status, 409);
  assert.equal(((await again!.json()) as { error: string }).error, "run_already_imported");
  const rows = await new SqliteOutcomeStore(env.DB as never).listOutcomes(run.id);
  assert.equal(rows.length, 1, "one subject, one row, however many times the client retried");
});

test("the engine evaluates the date the row is LABELLED with", async () => {
  // With the body silent and the run carrying an evaluationDate, the row was labelled with the run's
  // date while the engine evaluated TODAY — a regulatory record stating a period it was not computed
  // over (Codex, #389). Pinned on a date-derived define rather than on the label, because the label was
  // never the broken half.
  const daysSince = async (requestedScope: Record<string, unknown>, body: Record<string, unknown>) => {
    const run = (await (await post("/api/runs", { ...importRun, requestedScope }))!.json()) as { id: string };
    await post(`/api/runs/${run.id}/import`, {
      measureId: "audiogram",
      qrda1: [importableDocument(`mrn-${crypto.randomUUID()}`, `MBI-${crypto.randomUUID()}`)],
      ...body,
    });
    const [row] = await new SqliteOutcomeStore(env.DB as never).listOutcomes(run.id);
    const results = (row!.evidence as { expressionResults: Array<{ define: string; result: unknown }> }).expressionResults;
    return {
      period: row!.evaluationPeriod,
      days: results.find((r) => /days since/i.test(r.define))?.result,
    };
  };

  const fromRun = await daysSince({ measureId: "audiogram", importDriven: true, evaluationDate: "2025-01-15" }, {});
  const explicit = await daysSince({ measureId: "audiogram", importDriven: true }, { evaluationDate: "2025-01-15" });
  const today = await daysSince({ measureId: "audiogram", importDriven: true }, {});

  assert.equal(fromRun.period, "2025-01-15", "the row is labelled with the run's date");
  assert.equal(fromRun.days, explicit.days, "and the engine computed that date, not another one");
  assert.notEqual(fromRun.days, today.days, "which is a different answer from today's — so the check can fail");
});
