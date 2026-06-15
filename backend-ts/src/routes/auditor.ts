/**
 * Auditor route (#108) — downloadable evidence packets, TS port of AuditorController.
 *
 *   GET /api/auditor/runs/:runId/packet?format=json|html              → 200 (attachment) | 404 | 400
 *   GET /api/auditor/measure-versions/:id/packet?format=json|html     → 200 (attachment) | 404 | 400
 *
 * Role gates are applied centrally by the authorize() matrix (#105): run packets require
 * CASE_MANAGER/ADMIN, measure-version packets require APPROVER/ADMIN. The CASE packet is not
 * ported yet (depends on evidence/appointments/outreach_records).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { ensureMeasureStore } from "./measures.ts";
import {
  buildRunPacket,
  buildMeasureVersionPacket,
  PacketNotFoundError,
  type PacketFormat,
  type PacketResult,
} from "../audit/audit-packet.ts";

interface AuditorEnv {
  DB: CloudDatabase;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Ensure the floor schema (DDL + column backfill + catalog seed) is present once per DB. */
async function ensure(env: AuditorEnv): Promise<void> {
  await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  await migrateFloorSchema(env.DB);
  await ensureMeasureStore(env); // race-safe DDL + migrate + catalog seed (measure-version packet)
}

function parseFormat(raw: string | null): PacketFormat | null {
  const f = (raw ?? "json").toLowerCase();
  return f === "json" || f === "html" ? f : null;
}

function packetResponse(result: PacketResult): Response {
  return new Response(result.content, {
    status: 200,
    headers: {
      "content-type": result.contentType,
      "content-disposition": `attachment; filename="${result.filename}"`,
    },
  });
}

/** Returns a Response if this module owns the route, else null. */
export async function handleAuditor(req: Request, env: AuditorEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  const runId = pathname.match(/^\/api\/auditor\/runs\/([^/]+)\/packet$/)?.[1];
  const mvId = pathname.match(/^\/api\/auditor\/measure-versions\/([^/]+)\/packet$/)?.[1];
  if ((!runId && !mvId) || req.method !== "GET") return null;

  const format = parseFormat(url.searchParams.get("format"));
  if (!format) return json({ error: "invalid_format", message: "Unsupported format. Use format=json or format=html." }, 400);

  await ensure(env);
  try {
    if (runId) {
      const deps = {
        runStore: new SqliteRunStore(env.DB),
        outcomeStore: new SqliteOutcomeStore(env.DB),
        caseStore: new SqliteCaseStore(env.DB),
        events: new SqliteCaseEventStore(env.DB),
      };
      return packetResponse(await buildRunPacket(deps, runId, actor, format));
    }
    const deps = {
      measures: await ensureMeasureStore(env),
      outcomes: new SqliteOutcomeStore(env.DB),
      events: new SqliteCaseEventStore(env.DB),
    };
    return packetResponse(await buildMeasureVersionPacket(deps, mvId!, actor, format));
  } catch (err) {
    if (err instanceof PacketNotFoundError) return json({ error: "not_found", message: err.message }, 404);
    throw err;
  }
}
