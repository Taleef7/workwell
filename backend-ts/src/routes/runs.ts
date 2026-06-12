/**
 * Runs route (#103/#106) — the start of the run pipeline in TS: worker → RunStore +
 * OutcomeStore → CloudDatabase (SQLite floor), with subject evaluation through the
 * JVM-free CQL engine. NOT yet the full frontend `/api/runs` contract (Phase-4
 * strangler port, #107) — it wires the storage + engine seams together live.
 *
 *   POST /api/runs                  create a QUEUED run              → 201 RunRecord
 *   POST /api/runs/claim            claim next queued (?workerId)    → 200 RunRecord | 204
 *   POST /api/runs/:id/evaluate     evaluate a subject + persist     → 201 OutcomeRecord
 *                                   body {measureId, patientBundle, evaluationDate?}
 *   GET  /api/runs/:id/outcomes     list persisted outcomes for a run → 200 OutcomeRecord[]
 *   GET  /api/runs/:id              read a run                       → 200 RunRecord | 404
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import type { CreateRunInput } from "../stores/run-store.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";

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

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Returns a Response if this module owns the route, else null (let the worker continue). */
export async function handleRuns(req: Request, env: RunsEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

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
        status: result.outcome,
        evidence: result.evidence,
      });
      return json(record, 201);
    } catch (err) {
      return json({ error: "evaluation_error", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  const outcomesId = pathname.match(/^\/api\/runs\/([^/]+)\/outcomes$/)?.[1];
  if (outcomesId && req.method === "GET") {
    return json(await (await outcomes(env)).listOutcomes(outcomesId));
  }

  const id = pathname.match(/^\/api\/runs\/([^/]+)$/)?.[1];
  if (id && id !== "claim" && req.method === "GET") {
    const run = await (await store(env)).getRun(id);
    return run ? json(run) : json({ error: "not_found", id }, 404);
  }

  return null;
}
