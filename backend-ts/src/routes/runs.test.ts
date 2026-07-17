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
    assert.equal(body.totalEvaluated, 150, "immediate count remains the known static population");
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
