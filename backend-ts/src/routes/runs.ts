/**
 * Runs route (#103/#106/#107) — the run pipeline + read models in TS: worker →
 * RunStore + OutcomeStore → CloudDatabase (SQLite floor), with subject evaluation
 * through the JVM-free CQL engine. The GET endpoints serve the unchanged frontend
 * `/api/runs` contract (RunListItem / RunSummary / RunLogEntry) — Phase-4 strangler
 * port (#107), runs module, read-model slice.
 *
 *   GET  /api/runs                  newest-first run list            → 200 RunListItem[]
 *   GET  /api/runs/:id              run detail/summary               → 200 RunSummary | 404
 *   GET  /api/runs/:id/measure-report  FHIR R4 MeasureReport → 200 | 404 (unknown run) | 422 (multi-measure)
 *                                   ?type=summary (default) → summary report; individual|bundle → the
 *                                   collection Bundle (summary + per-subject individuals; the two are synonyms)
 *   GET  /api/runs/:id/logs         run log timeline                 → 200 RunLogEntry[]
 *   GET  /api/runs/:id/outcomes     persisted outcomes for a run     → 200 OutcomeRecord[]
 *   POST /api/runs                  create a QUEUED run              → 201 RunRecord
 *   POST /api/runs/claim            claim next queued (?workerId)    → 200 RunRecord | 204
 *   POST /api/runs/:id/evaluate     evaluate a subject + persist     → 201 OutcomeRecord
 *                                   body {measureId, patientBundle, evaluationDate?}
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import type { CreateRunInput, RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { toRunListItem, toRunSummary, toRunLogEntries, toRunOutcomeRows, matchesRunFilters, type RunFilters } from "../run/read-models.ts";
import { recoverStuckRuns } from "../run/recover-stuck-runs.ts";
import {
  executeManualRun,
  executeRerun,
  planManualRun,
  finishOrFail,
  rerunRequest,
  runningResponse,
  ASYNC_SCOPES,
  UnsupportedScopeError,
  InvalidRunRequestError,
  type ManualRunRequest,
  type ManualRunResponse,
  type RunPipelineDeps,
} from "../run/run-pipeline.ts";
import { rerunToVerify } from "../case/case-rerun.ts";
import { buildSummaryMeasureReport, buildMeasureReportBundle } from "../fhir/measure-report.ts";

interface RunsEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const engine: EvaluateMeasureBinding = new CqlExecutionEngine();

// The store factory selects the SQLite floor or the Postgres ceiling (when DATABASE_URL is set) and
// runs schema init once per env. CANONICAL schema/migrations stay Taleef-owned (CLAUDE.md).
//
// Boot recovery: an ALL_PROGRAMS/SITE run is advanced by an in-process `ctx.waitUntil` task that does
// NOT survive a container restart, so a run interrupted by a restart is stuck RUNNING forever. The
// first runs access in a process fires a best-effort sweep that fails such stuck runs. It is
// fire-and-forget (never blocks or fails the request) and time-thresholded (never touches a live run).
const sweptForOrphans = new WeakSet<object>();
async function store(env: RunsEnv): Promise<RunStore> {
  const stores = await getStores(env);
  if (!sweptForOrphans.has(env)) {
    sweptForOrphans.add(env);
    void recoverStuckRuns({ runs: stores.runs, events: stores.events })
      .then((ids) => {
        if (ids.length > 0)
          console.warn(`[workwell] recovered ${ids.length} stuck run(s) (RUNNING/QUEUED → FAILED, audited) on boot`);
      })
      .catch((err) => console.error("[workwell] stuck-run recovery failed:", err));
  }
  return stores.runs;
}
async function outcomes(env: RunsEnv): Promise<OutcomeStore> {
  return (await getStores(env)).outcomes;
}
async function cases(env: RunsEnv): Promise<CaseStore> {
  return (await getStores(env)).cases;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * Run an async-scope (ALL_PROGRAMS/SITE) manual run or rerun: create the run + return RUNNING
 * immediately, finish the fan-out in the background via waitUntil. The background promise gets a
 * rejection handler so a failure AFTER the response (recordOutcome/upsert/finalize) finalizes the
 * run FAILED instead of leaving it stuck RUNNING (which the page would poll forever). Returns the
 * RUNNING response, or null when this request should fall through to the synchronous path.
 */
async function scheduleAsyncRun(
  deps: RunPipelineDeps,
  body: ManualRunRequest,
  waitUntil: WaitUntil | undefined,
): Promise<ManualRunResponse | null> {
  if (!waitUntil || !ASYNC_SCOPES.has(body.scopeType)) return null;
  const planned = await planManualRun(deps, body);
  waitUntil(finishOrFail(deps, planned)); // finishOrFail finalizes FAILED on a post-response error
  return runningResponse(planned);
}

/** Parse a query int, falling back to `def`, clamped to [min, max] (bounds payloads). */
const clampInt = (raw: string | null, def: number, min: number, max: number): number => {
  const n = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

/** Build a ManualRunResponse from a completed rerun-to-verify (the runs page's contract). */
function caseRerunResponse(detail: {
  lastRunId: string;
  measureName: string;
  employeeName: string;
  currentOutcomeStatus: string;
}): ManualRunResponse {
  const compliant = detail.currentOutcomeStatus === "COMPLIANT" ? 1 : 0;
  return {
    runId: detail.lastRunId,
    scopeType: "CASE",
    scopeLabel: `Case: ${detail.measureName} / ${detail.employeeName}`,
    status: "COMPLETED",
    activeMeasuresExecuted: 1,
    totalEvaluated: 1,
    compliant,
    nonCompliant: 1 - compliant,
    message: `Rerun-to-verify completed with status ${detail.currentOutcomeStatus}.`,
    measuresExecuted: [detail.measureName],
  };
}

/** Returns a Response if this module owns the route, else null (let the worker continue). */
/** Schedules background work that must outlive the response (ctx.waitUntil); awaits inline if absent. */
export type WaitUntil = (p: Promise<unknown>) => void;

export async function handleRuns(req: Request, env: RunsEnv, actor = "system", waitUntil?: WaitUntil): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  // ---- read models (#107 strangler — runs module) -------------------------
  // List: newest-first run summaries for the worklist/history grid, honoring the
  // page's status/scopeType/triggerType/site/from/to filters (the Java contract).
  if (pathname === "/api/runs" && req.method === "GET") {
    const q = url.searchParams;
    const limit = clampInt(q.get("limit"), 100, 1, 1000);
    const filters: RunFilters = {
      status: q.get("status") ?? undefined,
      scopeType: q.get("scopeType") ?? undefined,
      triggerType: q.get("triggerType") ?? undefined,
      site: q.get("site") ?? undefined,
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
    };
    const runStore = await store(env);
    const outcomeStore = await outcomes(env);
    // Filter first, then cap, so `limit` bounds the *matching* rows (matches the Java
    // endpoint) rather than pre-truncating before filters apply.
    const matching = (await runStore.listRuns(1000)).filter((r) => matchesRunFilters(r, filters)).slice(0, limit);
    const items = await Promise.all(matching.map(async (r) => toRunListItem(r, await outcomeStore.listOutcomes(r.id))));
    return json(items);
  }

  // Run log timeline (clamp + forward the page's ?limit=200 to bound the payload).
  const logsId = pathname.match(/^\/api\/runs\/([^/]+)\/logs$/)?.[1];
  if (logsId && req.method === "GET") {
    const logLimit = clampInt(url.searchParams.get("limit"), 200, 1, 1000);
    return json(toRunLogEntries(await (await store(env)).listLogs(logsId, logLimit)));
  }

  // ---- write pipeline (#107 runs module) ----------------------------------
  // Manual scoped run: evaluate + persist + summarize. MEASURE/EMPLOYEE run synchronously
  // (≤ a few seconds); ALL_PROGRAMS/SITE fan out to ~1000 evaluations (~1 min), so they create
  // the run, return RUNNING immediately, and finish in the background (the page polls to terminal).
  if (pathname === "/api/runs/manual" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as ManualRunRequest;
    const deps = { runStore: await store(env), outcomeStore: await outcomes(env), caseStore: await cases(env), engine };
    try {
      const running = await scheduleAsyncRun(deps, body, waitUntil);
      if (running) return json(running, 201);
      // No waitUntil (e.g. tests) → fall back to synchronous completion for every scope.
      return json(await executeManualRun(deps, body), 201);
    } catch (err) {
      if (err instanceof UnsupportedScopeError) return json({ error: "unsupported_scope", message: err.message }, 501);
      if (err instanceof InvalidRunRequestError) return json({ error: "invalid_request", message: err.message }, 400);
      return json({ error: "run_failed", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // Rerun an existing run's scope as a new run.
  const rerunId = pathname.match(/^\/api\/runs\/([^/]+)\/rerun$/)?.[1];
  if (rerunId && req.method === "POST") {
    const runStore = await store(env);
    // A CASE run reruns through rerun-to-verify (the case scope), reading the caseId
    // persisted in requested_scope — matches Java's rerunSameScope CASE branch. Other
    // scopes go through executeRerun.
    const prior = await runStore.getRun(rerunId);
    if (!prior) return json({ error: "not_found", id: rerunId }, 404);
    if (prior.scopeType === "CASE") {
      const caseId = prior.requestedScope.caseId as string | undefined;
      if (!caseId) return json({ error: "invalid_request", message: "CASE run has no caseId to rerun" }, 400);
      const detail = await rerunToVerify(
        { cases: await cases(env), events: (await getStores(env)).events, outcomes: await outcomes(env), runStore, engine },
        caseId,
        actor,
      );
      if (!detail) return json({ error: "not_found", id: caseId }, 404);
      return json(caseRerunResponse(detail), 201);
    }
    const deps = { runStore, outcomeStore: await outcomes(env), caseStore: await cases(env), engine };
    try {
      // Wide-scope reruns (ALL_PROGRAMS/SITE) carry the same ~1000-eval fan-out as a fresh run,
      // so they must use the async waitUntil path too — not a synchronous executeRerun.
      const running = await scheduleAsyncRun(deps, rerunRequest(prior), waitUntil);
      if (running) return json(running, 201);
      return json(await executeRerun(deps, rerunId), 201);
    } catch (err) {
      if (err instanceof InvalidRunRequestError) return json({ error: "not_found", message: err.message }, 404);
      if (err instanceof UnsupportedScopeError) return json({ error: "unsupported_scope", message: err.message }, 501);
      return json({ error: "run_failed", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  if (pathname === "/api/runs" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Partial<CreateRunInput>;
    const now = new Date().toISOString();
    const run = await (await store(env)).createRun({
      scopeType: body.scopeType ?? "ALL_PROGRAMS",
      scopeId: body.scopeId,
      triggeredBy: body.triggeredBy ?? "spike",
      requestedScope: body.requestedScope ?? {},
      measurementPeriodStart: body.measurementPeriodStart ?? now,
      measurementPeriodEnd: body.measurementPeriodEnd ?? now,
    });
    return json(run, 201);
  }

  if (pathname === "/api/runs/claim" && req.method === "POST") {
    const workerId = url.searchParams.get("workerId") ?? "worker-1";
    const claimed = await (await store(env)).claimNextQueuedRun(workerId);
    return claimed ? json(claimed) : new Response(null, { status: 204 });
  }

  // Evaluate a subject through the JVM-free CQL engine and persist the outcome.
  const evalId = pathname.match(/^\/api\/runs\/([^/]+)\/evaluate$/)?.[1];
  if (evalId && req.method === "POST") {
    const runStore = await store(env);
    const run = await runStore.getRun(evalId);
    if (!run) return json({ error: "not_found", id: evalId }, 404);
    const body = (await req.json().catch(() => null)) as
      | { measureId?: string; patientBundle?: unknown; evaluationDate?: string }
      | null;
    if (!body?.measureId || !body.patientBundle) {
      return json({ error: "invalid_request", hint: "body requires { measureId, patientBundle }" }, 400);
    }
    // The outcome's evaluation_period must equal the date the engine actually evaluates with,
    // so repeat-non-complier history (grouped by period) doesn't collapse into a blank period.
    // Engine default when omitted is today (cql-execution-engine) — prefer the run's persisted
    // period, then today, mirroring that default.
    const evaluationPeriod =
      body.evaluationDate ?? (run.requestedScope.evaluationDate as string | undefined) ?? new Date().toISOString().slice(0, 10);
    // A run being processed must leave the QUEUED claim path so it isn't re-handed
    // to a worker (QUEUED → RUNNING; idempotent for already-running runs).
    await runStore.markRunning(evalId);
    try {
      const result = await engine.evaluate({
        measureId: body.measureId,
        patientBundle: body.patientBundle,
        evaluationDate: body.evaluationDate,
      });
      const record = await (await outcomes(env)).recordOutcome({
        runId: evalId,
        subjectId: result.subjectId,
        measureId: body.measureId,
        evaluationPeriod,
        status: result.outcome,
        evidence: result.evidence,
      });
      return json(record, 201);
    } catch (err) {
      return json({ error: "evaluation_error", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // Per-employee outcome rows for the run detail grid (RunOutcomeRow).
  const outcomesId = pathname.match(/^\/api\/runs\/([^/]+)\/outcomes$/)?.[1];
  if (outcomesId && req.method === "GET") {
    return json(toRunOutcomeRows(await (await outcomes(env)).listOutcomes(outcomesId)));
  }

  // FHIR MeasureReport for a completed single-measure run (#89 / E3.1).
  const mrId = pathname.match(/^\/api\/runs\/([^/]+)\/measure-report$/)?.[1];
  if (mrId && req.method === "GET") {
    const run = await (await store(env)).getRun(mrId);
    if (!run) return json({ error: "not_found", id: mrId }, 404);
    const rows = await (await outcomes(env)).listOutcomes(mrId);
    const measureIds = [...new Set(rows.map((o) => o.measureId))];
    if (measureIds.length !== 1) {
      return json(
        { error: "unsupported_run_scope", message: "MeasureReport requires a completed single-measure run", measures: measureIds.length },
        422,
      );
    }
    const measureId = measureIds[0]!;
    const type = url.searchParams.get("type") ?? "summary";
    const fhir = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/fhir+json" } });
    if (type === "summary") return fhir(buildSummaryMeasureReport(run, measureId, rows));
    if (type === "individual" || type === "bundle") return fhir(buildMeasureReportBundle(run, measureId, rows));
    return json({ error: "invalid_type", message: "type must be summary|individual|bundle" }, 400);
  }

  // Run detail/summary — the RunSummary contract (superset of RunListItem).
  const id = pathname.match(/^\/api\/runs\/([^/]+)$/)?.[1];
  if (id && id !== "claim" && req.method === "GET") {
    const run = await (await store(env)).getRun(id);
    if (!run) return json({ error: "not_found", id }, 404);
    const totalCases = await (await cases(env)).countByLastRun(id);
    return json(toRunSummary(run, await (await outcomes(env)).listOutcomes(id), totalCases));
  }

  return null;
}
