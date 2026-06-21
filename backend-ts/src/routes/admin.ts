/**
 * Admin route (#108 admin) — the `/admin` dashboard read surface + simple toggles, ported
 * from AdminController. Gated to ADMIN by the security matrix (/api/admin/** → ROLE_ADMIN).
 *
 *   GET  /api/admin/integrations                 + POST /:id/sync
 *   GET  /api/admin/scheduler                     + POST ?enabled=
 *   GET  /api/admin/audit-events?scope=&limit=
 *   GET  /api/admin/terminology-mappings
 *   GET  /api/admin/data-mappings
 *   GET  /api/admin/outreach-templates            + GET /:id/preview
 *   GET  /api/admin/waivers                       (empty — waiver subsystem deferred)
 *   GET  /api/admin/outreach/delivery-log         (empty — delivery-log persistence deferred)
 *
 * Faithful where data exists; honest empty where a subsystem isn't ported yet, so the
 * dashboard renders. Create/PUT/DELETE + demo-reset are a follow-up (need persistence).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores, getBackend } from "../stores/factory.ts";
import {
  listIntegrations,
  syncIntegration,
  schedulerStatus,
  setSchedulerEnabled,
  listDataMappings,
  validateDataMappings,
  toAdminAuditRows,
  toDeliveryLog,
} from "../admin/admin-data.ts";
import { ensureMeasureStore } from "./measures.ts";
import { listTerminologyMappings, createTerminologyMapping, ValueSetError } from "../measure/value-set-governance.ts";
import {
  seedOutreachTemplates,
  listTemplates,
  previewTemplate,
  createTemplate,
  updateTemplate,
  OutreachTemplateError,
} from "../admin/outreach-templates.ts";
import { resetDemoData } from "../admin/demo-reset.ts";
import { listWaivers, grantWaiver, WaiverError, type WaiverDeps } from "../admin/waivers.ts";
import { isProductionLike } from "../config/startup-safety.ts";

interface AdminEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  /** Production-like detection (gates off demo-reset, mirroring @Profile("!prod")). */
  SPRING_PROFILES_ACTIVE?: string;
  WORKWELL_ENVIRONMENT?: string;
  NODE_ENV?: string;
}

// Seed the outreach templates (V007/V008) once per env over the factory's store — the factory has
// already run schema init (SQLite floor or Postgres ceiling). Idempotent seed.
const seeding = new WeakMap<object, Promise<void>>();
async function ensure(env: AdminEnv): Promise<void> {
  const stores = await getStores(env);
  let seed = seeding.get(env);
  if (!seed) {
    seed = seedOutreachTemplates(stores.outreachTemplates);
    seeding.set(env, seed);
  }
  await seed;
}

/** Waiver deps: the waiver store + the measure store (display resolution) + audit. */
async function waiverDeps(env: AdminEnv): Promise<WaiverDeps> {
  const measures = await ensureMeasureStore(env); // ensures schema + catalog seed
  const s = await getStores(env);
  return { waivers: s.waivers, measures, events: s.events };
}

/**
 * Expand a bare `YYYY-MM-DD` waiver-expiry filter to a UTC instant bound (Java parseFromDate/
 * parseToDate): `after` → start of that day (00:00:00Z), `before` → end of that day (23:59:59Z) so
 * the bound compares correctly against the stored ISO timestamps. Throws on a non-date value.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function parseDayBound(raw: string | null, edge: "start" | "end", field: string): string | null {
  if (raw == null || raw.trim() === "") return null;
  const d = raw.trim();
  const start = DATE_ONLY.test(d) ? new Date(`${d}T00:00:00.000Z`) : new Date(NaN);
  if (Number.isNaN(start.getTime())) throw new WaiverError(`${field} must use YYYY-MM-DD`);
  if (edge === "start") return start.toISOString();
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1000).toISOString(); // end of UTC day (−1s, Java parity)
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const clampInt = (raw: string | null, def: number, min: number, max: number) => {
  const n = raw == null ? def : Number(raw);
  return !Number.isFinite(n) ? def : Math.min(max, Math.max(min, Math.trunc(n)));
};

export async function handleAdmin(req: Request, env: AdminEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const q = url.searchParams;

  // ---- integrations --------------------------------------------------------
  if (pathname === "/api/admin/integrations" && req.method === "GET") return json(listIntegrations());
  const syncId = pathname.match(/^\/api\/admin\/integrations\/([^/]+)\/sync$/)?.[1];
  if (syncId && req.method === "POST") {
    const h = syncIntegration(syncId);
    return h ? json(h) : json({ error: "not_found", integration: syncId }, 404);
  }

  // ---- scheduler -----------------------------------------------------------
  if (pathname === "/api/admin/scheduler" && req.method === "GET") return json(schedulerStatus());
  if (pathname === "/api/admin/scheduler" && req.method === "POST") {
    return json(setSchedulerEnabled((q.get("enabled") ?? "false").toLowerCase() === "true"));
  }

  // ---- audit viewer (over the persisted ledger) ----------------------------
  if (pathname === "/api/admin/audit-events" && req.method === "GET") {
    const s = await getStores(env);
    const events = await s.events.listAuditEvents();
    const caseStore = s.cases;
    const caseEmployee = new Map<string, string>();
    for (const id of new Set(events.map((e) => e.refCaseId).filter((x): x is string => !!x))) {
      const c = await caseStore.getCase(id);
      if (c) caseEmployee.set(id, c.employeeId);
    }
    const limit = clampInt(q.get("limit"), 100, 1, 250);
    return json(toAdminAuditRows(events, caseEmployee, q.get("scope") ?? "all", limit));
  }

  // ---- terminology mappings (persisted; demo rows seeded with the value sets) ----
  if (pathname === "/api/admin/terminology-mappings" && req.method === "GET") {
    await ensureMeasureStore(env); // runs the value-set + terminology demo seed
    return json(await listTerminologyMappings((await getStores(env)).valueSets));
  }
  if (pathname === "/api/admin/terminology-mappings" && req.method === "POST") {
    await ensureMeasureStore(env);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const sx = await getStores(env);
      const deps = { valueSets: sx.valueSets, events: sx.events };
      const created = await createTerminologyMapping(
        deps,
        {
          localCode: String(body.localCode ?? ""),
          localDisplay: body.localDisplay == null ? null : String(body.localDisplay),
          localSystem: String(body.localSystem ?? ""),
          standardCode: String(body.standardCode ?? ""),
          standardDisplay: body.standardDisplay == null ? null : String(body.standardDisplay),
          standardSystem: String(body.standardSystem ?? ""),
          mappingStatus: body.mappingStatus == null ? null : String(body.mappingStatus),
          mappingConfidence: body.mappingConfidence == null ? null : Number(body.mappingConfidence),
          notes: body.notes == null ? null : String(body.notes),
        },
        actor,
      );
      return json(created, 201);
    } catch (err) {
      if (err instanceof ValueSetError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }
  // ---- static / faithful reads --------------------------------------------
  if (pathname === "/api/admin/data-mappings" && req.method === "GET") return json(listDataMappings());
  if (pathname === "/api/admin/data-mappings/validate" && req.method === "POST") return json(validateDataMappings());

  // ---- outreach templates (persisted; V007 demo seed + create/update) ------
  if (pathname === "/api/admin/outreach-templates" && req.method === "GET") {
    await ensure(env);
    return json(await listTemplates((await getStores(env)).outreachTemplates));
  }
  if (pathname === "/api/admin/outreach-templates" && req.method === "POST") {
    await ensure(env);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const sx = await getStores(env);
      const created = await createTemplate(
        sx.outreachTemplates,
        sx.events,
        { name: String(b.name ?? ""), subject: String(b.subject ?? ""), bodyText: String(b.bodyText ?? ""), type: b.type == null ? null : String(b.type) },
        actor,
      );
      return json(created, 201);
    } catch (err) {
      if (err instanceof OutreachTemplateError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }
  const updateId = pathname.match(/^\/api\/admin\/outreach-templates\/([^/]+)$/)?.[1];
  if (updateId && req.method === "PUT") {
    await ensure(env);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const sx = await getStores(env);
      const updated = await updateTemplate(
        sx.outreachTemplates,
        sx.events,
        updateId,
        {
          name: String(b.name ?? ""),
          subject: String(b.subject ?? ""),
          bodyText: String(b.bodyText ?? ""),
          type: b.type == null ? null : String(b.type),
          active: b.active == null ? true : Boolean(b.active),
        },
        actor,
      );
      return updated ? json(updated) : json({ error: "not_found", id: updateId }, 404);
    } catch (err) {
      if (err instanceof OutreachTemplateError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }
  const previewId = pathname.match(/^\/api\/admin\/outreach-templates\/([^/]+)\/preview$/)?.[1];
  if (previewId && req.method === "GET") {
    await ensure(env);
    try {
      return json(await previewTemplate((await getStores(env)).outreachTemplates, previewId));
    } catch (err) {
      if (err instanceof OutreachTemplateError) return json({ error: "not_found", id: previewId }, 404);
      throw err;
    }
  }

  // ---- demo reset (non-prod only; mirrors @Profile("!prod")) ---------------
  if (pathname === "/api/admin/demo-reset" && req.method === "POST") {
    if (isProductionLike(env)) return json({ error: "Demo reset is not available in production" }, 403);
    await ensure(env);
    await resetDemoData(await getBackend(env));
    return json({ status: "reset_complete", message: "Demo data has been reset" });
  }

  // ---- waivers (persisted; list + grant) -----------------------------------
  if (pathname === "/api/admin/waivers" && req.method === "GET") {
    const deps = await waiverDeps(env);
    const activeRaw = q.get("active");
    try {
      return json(
        await listWaivers(deps, {
          measureId: q.get("measureId"),
          site: q.get("site"),
          expiresAfter: parseDayBound(q.get("expiresAfter"), "start", "expiresAfter"),
          expiresBefore: parseDayBound(q.get("expiresBefore"), "end", "expiresBefore"),
          active: activeRaw == null || activeRaw === "" ? null : activeRaw.toLowerCase() === "true",
        }),
      );
    } catch (err) {
      if (err instanceof WaiverError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }
  if (pathname === "/api/admin/waivers" && req.method === "POST") {
    const deps = await waiverDeps(env);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const granted = await grantWaiver(
        deps,
        {
          employeeExternalId: String(b.employeeExternalId ?? ""),
          measureId: String(b.measureId ?? ""),
          exclusionReason: String(b.exclusionReason ?? ""),
          expiresAt: b.expiresAt == null ? null : String(b.expiresAt),
          notes: b.notes == null ? null : String(b.notes),
          active: b.active == null ? null : Boolean(b.active),
        },
        actor,
      );
      return json(granted, 201);
    } catch (err) {
      if (err instanceof WaiverError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }

  // Outreach delivery log (M3): derived from CASE_OUTREACH_SENT audit events (no dedicated table on
  // the demo stack — see admin-data.toDeliveryLog). Was previously a hardcoded empty array.
  if (pathname === "/api/admin/outreach/delivery-log" && req.method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? "20") || 20));
    const events = await (await getStores(env)).events.recentAuditEventsByType("CASE_OUTREACH_SENT", limit);
    return json(toDeliveryLog(events, limit));
  }

  return null;
}
