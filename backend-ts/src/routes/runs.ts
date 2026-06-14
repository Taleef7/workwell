/**
 * Runs route (#103/#106/#107) — the run pipeline + read models in TS: worker →
 * RunStore + OutcomeStore → CloudDatabase (SQLite floor), with subject evaluation
 * through the JVM-free CQL engine. The GET endpoints serve the unchanged frontend
 * `/api/runs` contract (RunListItem / RunSummary / RunLogEntry) — Phase-4 strangler
 * port (#107), runs module, read-model slice.
 *
 *   GET  /api/runs                  newest-first run list            → 200 RunListItem[]
 *   GET  /api/runs/:id              run detail/summary               → 200 RunSummary | 404
 *   GET  /api/runs/:id/logs         run log timeline                 → 200 RunLogEntry[]
 *   GET  /api/runs/:id/outcomes     persisted outcomes for a run     → 200 OutcomeRecord[]
 *   POST /api/runs                  create a QUEUED run              → 201 RunRecord
 *   POST /api/runs/claim            claim next queued (?workerId)    → 200 RunRecord | 204
 *   POST /api/runs/:id/evaluate     evaluate a subject + persist     → 201 OutcomeRecord
 *                                   body {measureId, patientBundle, evaluationDate?}
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import type { CreateRunInput } from "../stores/run-store.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { toRunListItem, toRunSummary, toRunLogEntries, toRunOutcomeRows, matchesRunFilters, type RunFilters } from "../run/read-models.ts";
import {
  executeManualRun,
  executeRerun,
  UnsupportedScopeError,
  InvalidRunRequestError,
  type ManualRunRequest,
  type ManualRunResponse,
} from "../run/run-pipeline.ts";
import { rerunToVerify } from "../case/case-rerun.ts";

interface RunsEnv {
  DB: CloudDatabase;
}

const engine: EvaluateMeasureBinding = new CqlExecutionEngine();

// Spike bootstrap: ensure the floor schema once per DB. CANONICAL schema/migrations
// stay Taleef-owned (CLAUDE.md) — this only touches the local SQLite dev DB.
const ready = new WeakSet<object>();
async function ensure(env: RunsEnv): Promise<void> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    await migrateFloorSchema(env.DB);
    ready.add(env.DB);
  }
}
async function store(env: RunsEnv): Promise<SqliteRunStore> {
  await ensure(env);
  return new SqliteRunStore(env.DB);
}
async function outcomes(env: RunsEnv): Promise<SqliteOutcomeStore> {
  await ensure(env);
  return new SqliteOutcomeStore(env.DB);
}
async function cases(env: RunsEnv): Promise<SqliteCaseStore> {
  await ensure(env);
  return new SqliteCaseStore(env.DB);
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

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
export async function handleRuns(req: Request, env: RunsEnv, actor = "system"): Promise<Response | null> {
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
  // Manual scoped run (MEASURE / EMPLOYEE): evaluate + persist + summarize.
  if (pathname === "/api/runs/manual" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as ManualRunRequest;
    const deps = { runStore: await store(env), outcomeStore: await outcomes(env), caseStore: await cases(env), engine };
    try {
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
        { cases: await cases(env), events: new SqliteCaseEventStore(env.DB), outcomes: await outcomes(env), runStore, engine },
        caseId,
        actor,
      );
      if (!detail) return json({ error: "not_found", id: caseId }, 404);
      return json(caseRerunResponse(detail), 201);
    }
    const deps = { runStore, outcomeStore: await outcomes(env), caseStore: await cases(env), engine };
    try {
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
    if (!(await runStore.getRun(evalId))) return json({ error: "not_found", id: evalId }, 404);
    const body = (await req.json().catch(() => null)) as
      | { measureId?: string; patientBundle?: unknown; evaluationDate?: string }
      | null;
    if (!body?.measureId || !body.patientBundle) {
      return json({ error: "invalid_request", hint: "body requires { measureId, patientBundle }" }, 400);
    }
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
        evaluationPeriod: body.evaluationDate ?? "",
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
