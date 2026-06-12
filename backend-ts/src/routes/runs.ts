/**
 * Runs route (spike, #103) — proves the worker → RunStore → CloudDatabase (SQLite)
 * path end-to-end. This is NOT yet the full frontend `/api/runs` contract (that is
 * the Phase-4 strangler port, #107); it exercises the storage contract live.
 *
 *   POST /api/runs            create a QUEUED run            → 201 RunRecord
 *   GET  /api/runs/:id        read a run                     → 200 RunRecord | 404
 *   POST /api/runs/claim      claim next queued (?workerId)  → 200 RunRecord | 204
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import type { CreateRunInput } from "../stores/run-store.ts";

interface RunsEnv {
  DB: CloudDatabase;
}

// Spike bootstrap: ensure the floor schema once per DB. CANONICAL schema/migrations
// stay Taleef-owned (CLAUDE.md) — this only touches the local SQLite dev DB.
const ready = new WeakSet<object>();
async function store(env: RunsEnv): Promise<SqliteRunStore> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    ready.add(env.DB);
  }
  return new SqliteRunStore(env.DB);
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

  const id = pathname.match(/^\/api\/runs\/([^/]+)$/)?.[1];
  if (id && id !== "claim" && req.method === "GET") {
    const run = await (await store(env)).getRun(id);
    return run ? json(run) : json({ error: "not_found", id }, 404);
  }

  return null;
}
