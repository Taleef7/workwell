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
 *   GET  /api/runs/:id/qrda           QRDA Category III aggregate stub (XML) → 200 | 404 | 422
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
import type { HydratedSegment } from "../stores/segment-store.ts";
import { ensureSegmentSeed } from "../segment/segment-seed.ts";
import { engineForEnv } from "../engine/cql/engine-factory.ts";
import { toRunListItemFromCounts, toRunSummaryFromCounts, toRunLogEntries, toRunOutcomeRows, matchesRunFilters, type RunFilters } from "../run/read-models.ts";
import { recoverStuckRuns } from "../run/recover-stuck-runs.ts";
import { resolveAlertChannels } from "../run/alert-channel.ts";
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
import { isIncrementalEnabled } from "../run/incremental/incremental-eval.ts";
import { isVsacConfigured } from "../engine/cql/resolve-value-set-resolver.ts";
import { rerunToVerify, UnsupportedCaseRerunError } from "../case/case-rerun.ts";
import { buildMeasureReportBundle, buildSummaryMeasureReportFromCounts, populationCountsFromStatus } from "../fhir/measure-report.ts";
import { buildQrda3DocumentFromCounts } from "../fhir/qrda3-export.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";

interface RunsEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  /** Optional failed-run webhook (#264). Inert unless set — see resolveAlertChannels. */
  WORKWELL_ALERT_WEBHOOK_URL?: string;
  WORKWELL_WEBCHART_ENROLLMENT_JSON?: string;
  /** #263 incremental evaluation opt-in. Inert unless "true". */
  WORKWELL_INCREMENTAL_EVAL?: string;
  /** #263 — folds value-set membership into logic_version when VSAC expansion is active. */
  WORKWELL_VSAC_API_KEY?: string;
  WORKWELL_VSAC_BASE_URL?: string;
}

// A run in one of these statuses has finished — its outcomes are final. Read models treat a terminal
// run as immutable and key on its (unchanged) runId: the roster cell cache (#233), the scale-run memo,
// `latestRunRows`, and the quality snapshots. So the `/evaluate` write path must refuse to append into
// a terminal run (a `markRunning` no-op would otherwise leave it terminal while gaining rows, silently
// changing a finished run under those caches). The async worker only ever evaluates QUEUED/RUNNING runs.
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "PARTIAL_FAILURE", "FAILED", "CANCELLED"]);

// Reserved trigger labels are load-bearing IDENTITY, not free-form text: `seed:*` drives SEED
// classification + scale-run decoding (`aggregateScaleRun` splits `mhn|Lxx|Pxx|n` subject ids) +
// the seed CLIs' idempotency, and `scheduler` drives SCHEDULED classification + the 24h debounce.
// They must only ever be set by internal callers (the seed CLIs, the scheduler) that invoke the
// pipeline directly — never by an HTTP body. An external caller posting `{"triggeredBy":"seed:scale"}`
// would corrupt quality snapshots (live emp-* ids fed through the `|` decoder) and postpone the real
// nightly run, so a caller-supplied reserved label is coerced back to a plain operator label (Fable M1).
const RESERVED_TRIGGER_PREFIXES = ["seed:", "scheduler"];
function externalTriggeredBy(raw: unknown): string {
  // Untrusted request input: the body is only type-cast, so a malformed `{"triggeredBy":123}` would
  // reach here as a non-string and throw `raw.trim is not a function` before the route could return a
  // controlled response (Codex P2). Accept only strings; default everything else to a plain label.
  if (typeof raw !== "string") return "manual";
  const t = raw.trim();
  if (!t) return "manual";
  const lower = t.toLowerCase();
  if (RESERVED_TRIGGER_PREFIXES.some((p) => lower.startsWith(p))) return "manual";
  return t;
}

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
    void recoverStuckRuns({
      runs: stores.runs,
      events: stores.events,
      alertChannels: resolveAlertChannels(env),
    })
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
/** Enabled segments only — the run pipeline gates case creation by applicability (#183 E11.3);
 *  zero enabled segments ⇒ all (subject, measure) pairs are applicable (reversibility). */
async function enabledSegments(env: RunsEnv): Promise<HydratedSegment[]> {
  await ensureSegmentSeed(env);
  const all = await (await getStores(env)).segments.listSegments();
  return all.filter((s) => s.enabled);
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Cap on subjects for a per-subject (individual/bundle) MeasureReport — a 120k seed:scale run would
 *  otherwise build a 120k-entry document (Fable H4). The summary report is the aggregate above this. */
const MAX_INDIVIDUAL_REPORT_SUBJECTS = 5000;

/** The run-detail outcomes grid returns a whole run up to this size (a live ALL_PROGRAMS run is ~2,100
 *  rows); a larger run (a 120k seed:scale run) is capped to the first page so the worker never
 *  materializes 120k hydrated rows (Fable H4 / Codex P2). Above this, page with an explicit ?limit. */
const OUTCOMES_GRID_FULL_CAP = 5000;

/**
 * Run an async-scope (ALL_PROGRAMS/SITE or configured-live MEASURE) manual run or rerun: create the run + return RUNNING
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
  const configuredMeasure = body.scopeType === "MEASURE" && isWebChartConfigured(deps.webChartEnv ?? {});
  if (!waitUntil || (!ASYNC_SCOPES.has(body.scopeType) && !configuredMeasure)) return null;
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

export async function handleRuns(
  req: Request,
  env: RunsEnv,
  actor = "system",
  waitUntil?: WaitUntil,
  generatedAt = new Date().toISOString(),
): Promise<Response | null> {
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
    // Bounded GROUP BY per run (not listOutcomes) so the list never materializes the 120k-row
    // seed:scale outcomes — the previous per-run full-row load pushed ?limit=20 past the 60s gateway
    // timeout once scale was seeded on Neon (post-audit perf fix).
    const items = await Promise.all(matching.map(async (r) => toRunListItemFromCounts(r, await outcomeStore.countOutcomesByStatus(r.id))));
    return json(items);
  }

  // Run log timeline (clamp + forward the page's ?limit=200 to bound the payload).
  const logsId = pathname.match(/^\/api\/runs\/([^/]+)\/logs$/)?.[1];
  if (logsId && req.method === "GET") {
    const logLimit = clampInt(url.searchParams.get("limit"), 200, 1, 1000);
    return json(toRunLogEntries(await (await store(env)).listLogs(logsId, logLimit)));
  }

  // ---- write pipeline (#107 runs module) ----------------------------------
  // Manual scoped run: evaluate + persist + summarize. Static MEASURE/EMPLOYEE run synchronously
  // (≤ a few seconds); ALL_PROGRAMS/SITE and configured-live MEASURE create the run, return RUNNING
  // immediately, and finish the fan-out/remote load in the background (the page polls to terminal).
  if (pathname === "/api/runs/manual" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as ManualRunRequest;
    body.triggeredBy = externalTriggeredBy(body.triggeredBy); // Fable M1: no forged seed:*/scheduler labels
    const engine = await engineForEnv(env);
    const deps = {
      runStore: await store(env),
      outcomeStore: await outcomes(env),
      caseStore: await cases(env),
      engine,
      segments: await enabledSegments(env),
      qualitySnapshots: (await getStores(env)).qualitySnapshots,
      events: (await getStores(env)).events,
      actor, // audit attribution from the auth middleware, not the body's triggeredBy (Codex P1)
      alertChannels: resolveAlertChannels(env), // #264 failed-run alerts (console + optional webhook)
      webChartEnv: env,
      evalState: (await getStores(env)).evalState, // #263 incremental cache (inert unless the flag is set)
      incremental: isIncrementalEnabled(env),
      expansionActive: isVsacConfigured(env), // #263 — folds value-set membership into logic_version
      valueSets: (await getStores(env)).valueSets,
    };
    try {
      const running = await scheduleAsyncRun(deps, body, waitUntil);
      if (running) return json(running, 201);
      // No waitUntil (e.g. tests) → fall back to synchronous completion for every scope.
      return json(await executeManualRun(deps, body), 201);
    } catch (err) {
      if (err instanceof UnsupportedScopeError) return json({ error: "unsupported_scope", message: err.message }, err.status);
      if (err instanceof InvalidRunRequestError) return json({ error: "invalid_request", message: err.message }, 400);
      return json({ error: "run_failed", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // Rerun an existing run's scope as a new run.
  const rerunId = pathname.match(/^\/api\/runs\/([^/]+)\/rerun$/)?.[1];
  if (rerunId && req.method === "POST") {
    const runStore = await store(env);
    const engine = await engineForEnv(env);
    // A CASE run reruns through rerun-to-verify (the case scope), reading the caseId
    // persisted in requested_scope — matches Java's rerunSameScope CASE branch. Other
    // scopes go through executeRerun.
    const prior = await runStore.getRun(rerunId);
    if (!prior) return json({ error: "not_found", id: rerunId }, 404);
    if (prior.scopeType === "CASE") {
      const caseId = prior.requestedScope.caseId as string | undefined;
      if (!caseId) return json({ error: "invalid_request", message: "CASE run has no caseId to rerun" }, 400);
      try {
        const detail = await rerunToVerify(
          { cases: await cases(env), events: (await getStores(env)).events, outcomes: await outcomes(env), runStore, engine },
          caseId,
          actor,
        );
        if (!detail) return json({ error: "not_found", id: caseId }, 404);
        return json(caseRerunResponse(detail), 201);
      } catch (err) {
        if (err instanceof UnsupportedCaseRerunError) return json({ error: err.code, message: err.message }, 409);
        throw err;
      }
    }
    const deps = {
      runStore,
      outcomeStore: await outcomes(env),
      caseStore: await cases(env),
      engine,
      segments: await enabledSegments(env),
      qualitySnapshots: (await getStores(env)).qualitySnapshots,
      events: (await getStores(env)).events,
      actor, // audit attribution from the auth middleware (Codex P1)
      alertChannels: resolveAlertChannels(env), // #264 failed-run alerts
      webChartEnv: env,
      evalState: (await getStores(env)).evalState, // #263 incremental cache (inert unless the flag is set)
      incremental: isIncrementalEnabled(env),
      expansionActive: isVsacConfigured(env), // #263 — folds value-set membership into logic_version
      valueSets: (await getStores(env)).valueSets,
    };
    try {
      // Wide-scope reruns (ALL_PROGRAMS/SITE) carry the same ~1000-eval fan-out as a fresh run,
      // so they must use the async waitUntil path too — not a synchronous executeRerun.
      const running = await scheduleAsyncRun(deps, rerunRequest(prior), waitUntil);
      if (running) return json(running, 201);
      return json(await executeRerun(deps, rerunId), 201);
    } catch (err) {
      if (err instanceof InvalidRunRequestError) return json({ error: "not_found", message: err.message }, 404);
      if (err instanceof UnsupportedScopeError) return json({ error: "unsupported_scope", message: err.message }, err.status);
      return json({ error: "run_failed", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  if (pathname === "/api/runs" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Partial<CreateRunInput>;
    const now = new Date().toISOString();
    const run = await (await store(env)).createRun({
      scopeType: body.scopeType ?? "ALL_PROGRAMS",
      scopeId: body.scopeId,
      triggeredBy: externalTriggeredBy(body.triggeredBy), // Fable M1: no forged seed:*/scheduler labels

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
    // Refuse to append into a finished run — keeps a terminal run's outcomes immutable so the read-model
    // caches that key on runId (roster #233, scale memo, quality snapshots) can't serve stale rows.
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return json({ error: "run_not_open", id: evalId, status: run.status, hint: "cannot evaluate into a terminal run" }, 409);
    }
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
    const engine = await engineForEnv(env);
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

  // Per-employee outcome rows for the run detail grid (RunOutcomeRow). Bounded for the 120k seed:scale
  // runs (Fable H4) WITHOUT truncating a normal run (Codex P2): the legacy default returns the whole run
  // — a live ALL_PROGRAMS run is only ~2,100 rows, and the /runs page renders the array directly without
  // paging — and only a pathologically large (scale) run is capped to the first page so the single-replica
  // worker never materializes 120k hydrated rows. An explicit ?limit/?offset always pages. X-Total-Count
  // carries the true count (a bounded GROUP BY) so a paging client can detect a capped scale run.
  const outcomesId = pathname.match(/^\/api\/runs\/([^/]+)\/outcomes$/)?.[1];
  if (outcomesId && req.method === "GET") {
    const os = await outcomes(env);
    const total = (await os.countOutcomesByStatus(outcomesId)).reduce((sum, c) => sum + c.count, 0);
    const hasExplicitPaging = url.searchParams.has("limit") || url.searchParams.has("offset");
    let rows;
    if (hasExplicitPaging) {
      const limit = clampInt(url.searchParams.get("limit"), 500, 1, 2000);
      const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      rows = await os.listOutcomes(outcomesId, { limit, offset });
    } else if (total > OUTCOMES_GRID_FULL_CAP) {
      rows = await os.listOutcomes(outcomesId, { limit: OUTCOMES_GRID_FULL_CAP }); // oversized (scale) run
    } else {
      rows = await os.listOutcomes(outcomesId); // whole run — no truncation for normal runs
    }
    return new Response(JSON.stringify(toRunOutcomeRows(rows)), {
      status: 200,
      headers: { "content-type": "application/json", "X-Total-Count": String(total) },
    });
  }

  // QRDA Category III aggregate export (stub) for a completed single-measure run (#91 / E3.3). Built
  // from the bounded status histogram, not the per-subject rows (Fable H4) — safe at 120k scale.
  const qrdaId = pathname.match(/^\/api\/runs\/([^/]+)\/qrda$/)?.[1];
  if (qrdaId && req.method === "GET") {
    const run = await (await store(env)).getRun(qrdaId);
    if (!run) return json({ error: "not_found", id: qrdaId }, 404);
    const os = await outcomes(env);
    const measureIds = await os.distinctMeasuresForRun(qrdaId, 2);
    if (measureIds.length !== 1) {
      return json(
        { error: "unsupported_run_scope", message: "QRDA III requires a completed single-measure run", measures: measureIds.length },
        422,
      );
    }
    const fmt = url.searchParams.get("format") ?? "xml";
    if (fmt !== "xml") return json({ error: "invalid_format", message: "QRDA III is XML only" }, 400);
    const measureId = measureIds[0]!;
    const counts = populationCountsFromStatus(await os.countOutcomesByStatus(qrdaId), measureId);
    return new Response(buildQrda3DocumentFromCounts(run, measureId, counts), {
      status: 200,
      headers: {
        "content-type": "application/xml",
        "content-disposition": `attachment; filename="qrda3-${qrdaId}.xml"`,
      },
    });
  }

  // FHIR MeasureReport for a completed single-measure run (#89 / E3.1).
  const mrId = pathname.match(/^\/api\/runs\/([^/]+)\/measure-report$/)?.[1];
  if (mrId && req.method === "GET") {
    const run = await (await store(env)).getRun(mrId);
    if (!run) return json({ error: "not_found", id: mrId }, 404);
    const os = await outcomes(env);
    const measureIds = await os.distinctMeasuresForRun(mrId, 2);
    if (measureIds.length !== 1) {
      return json(
        { error: "unsupported_run_scope", message: "MeasureReport requires a completed single-measure run", measures: measureIds.length },
        422,
      );
    }
    const measureId = measureIds[0]!;
    const type = url.searchParams.get("type") ?? "summary";
    const fhir = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "content-type": "application/fhir+json",
          "content-disposition": `attachment; filename="measure-report-${mrId}-${type}.json"`,
        },
      });
    // summary = aggregate counts only → bounded status histogram, never the per-subject rows (Fable H4).
    if (type === "summary") {
      const counts = populationCountsFromStatus(await os.countOutcomesByStatus(mrId), measureId);
      return fhir(buildSummaryMeasureReportFromCounts(run, measureId, counts, generatedAt));
    }
    // individual/bundle emits one MeasureReport per subject; a 120k seed:scale run would build a
    // 120k-entry document. Cap it (Fable H4) — the summary is the aggregate for oversized runs.
    if (type === "individual" || type === "bundle") {
      const total = (await os.countOutcomesByStatus(mrId)).reduce((sum, c) => sum + c.count, 0);
      if (total > MAX_INDIVIDUAL_REPORT_SUBJECTS) {
        return json(
          {
            error: "run_too_large",
            message: `A per-subject ${type} MeasureReport is limited to ${MAX_INDIVIDUAL_REPORT_SUBJECTS} subjects; this run has ${total}. Use ?type=summary for the aggregate.`,
            subjects: total,
            limit: MAX_INDIVIDUAL_REPORT_SUBJECTS,
          },
          422,
        );
      }
      const rows = await os.listOutcomes(mrId, { limit: MAX_INDIVIDUAL_REPORT_SUBJECTS });
      return fhir(buildMeasureReportBundle(run, measureId, rows, generatedAt));
    }
    return json({ error: "invalid_type", message: "type must be summary|individual|bundle" }, 400);
  }

  // Run detail/summary — the RunSummary contract (superset of RunListItem).
  const id = pathname.match(/^\/api\/runs\/([^/]+)$/)?.[1];
  if (id && id !== "claim" && req.method === "GET") {
    const run = await (await store(env)).getRun(id);
    if (!run) return json({ error: "not_found", id }, 404);
    const totalCases = await (await cases(env)).countByLastRun(id);
    // Counts-based summary (bounded GROUP BY) so opening a 120k-row seed:scale run's detail header is
    // also fast; the per-employee outcomes grid (/outcomes) still loads rows on demand.
    return json(toRunSummaryFromCounts(run, await (await outcomes(env)).countOutcomesByStatus(id), totalCases));
  }

  return null;
}
