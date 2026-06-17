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
import { getStores } from "../stores/factory.ts";
import { ensureMeasureStore } from "./measures.ts";
import {
  buildRunPacket,
  buildMeasureVersionPacket,
  buildCasePacket,
  PacketNotFoundError,
  type PacketFormat,
  type PacketResult,
} from "../audit/audit-packet.ts";

interface AuditorEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Ensure schema (via the store factory) + the catalog seed (needed by the measure-version packet). */
async function ensure(env: AuditorEnv): Promise<void> {
  await ensureMeasureStore(env); // factory schema init + race-safe catalog seed
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
  const caseId = pathname.match(/^\/api\/auditor\/cases\/([^/]+)\/packet$/)?.[1];
  if ((!runId && !mvId && !caseId) || req.method !== "GET") return null;

  const format = parseFormat(url.searchParams.get("format"));
  if (!format) return json({ error: "invalid_format", message: "Unsupported format. Use format=json or format=html." }, 400);

  await ensure(env);
  const s = await getStores(env);
  try {
    if (runId) {
      const deps = {
        runStore: s.runs,
        outcomeStore: s.outcomes,
        caseStore: s.cases,
        events: s.events,
      };
      return packetResponse(await buildRunPacket(deps, runId, actor, format));
    }
    if (caseId) {
      const deps = {
        cases: s.cases,
        outcomes: s.outcomes,
        events: s.events,
        evidence: s.evidence,
        appointments: s.appointments,
      };
      return packetResponse(await buildCasePacket(deps, caseId, actor, format));
    }
    const deps = {
      measures: await ensureMeasureStore(env),
      outcomes: s.outcomes,
      events: s.events,
    };
    return packetResponse(await buildMeasureVersionPacket(deps, mvId!, actor, format));
  } catch (err) {
    if (err instanceof PacketNotFoundError) return json({ error: "not_found", message: err.message }, 404);
    throw err;
  }
}
