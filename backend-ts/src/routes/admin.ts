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
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import {
  listIntegrations,
  syncIntegration,
  schedulerStatus,
  setSchedulerEnabled,
  listTerminologyMappings,
  listDataMappings,
  listOutreachTemplates,
  findOutreachTemplate,
  toAdminAuditRows,
} from "../admin/admin-data.ts";

interface AdminEnv {
  DB: CloudDatabase;
}

const ready = new WeakSet<object>();
async function ensure(env: AdminEnv): Promise<void> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    await migrateFloorSchema(env.DB);
    ready.add(env.DB);
  }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const clampInt = (raw: string | null, def: number, min: number, max: number) => {
  const n = raw == null ? def : Number(raw);
  return !Number.isFinite(n) ? def : Math.min(max, Math.max(min, Math.trunc(n)));
};

export async function handleAdmin(req: Request, env: AdminEnv): Promise<Response | null> {
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
    await ensure(env);
    const events = await new SqliteCaseEventStore(env.DB).listAuditEvents();
    const caseStore = new SqliteCaseStore(env.DB);
    const caseEmployee = new Map<string, string>();
    for (const id of new Set(events.map((e) => e.refCaseId).filter((x): x is string => !!x))) {
      const c = await caseStore.getCase(id);
      if (c) caseEmployee.set(id, c.employeeId);
    }
    const limit = clampInt(q.get("limit"), 100, 1, 250);
    return json(toAdminAuditRows(events, caseEmployee, q.get("scope") ?? "all", limit));
  }

  // ---- static / faithful reads --------------------------------------------
  if (pathname === "/api/admin/terminology-mappings" && req.method === "GET") return json(listTerminologyMappings());
  if (pathname === "/api/admin/data-mappings" && req.method === "GET") return json(listDataMappings());
  if (pathname === "/api/admin/outreach-templates" && req.method === "GET") return json(listOutreachTemplates());
  const previewId = pathname.match(/^\/api\/admin\/outreach-templates\/([^/]+)\/preview$/)?.[1];
  if (previewId && req.method === "GET") {
    const t = findOutreachTemplate(previewId);
    return t ? json({ id: t.id, name: t.name, subject: t.subject, bodyText: t.bodyText }) : json({ error: "not_found", id: previewId }, 404);
  }

  // ---- deferred subsystems (honest empty so the dashboard renders) ---------
  if (pathname === "/api/admin/waivers" && req.method === "GET") return json([]);
  if (pathname === "/api/admin/outreach/delivery-log" && req.method === "GET") return json([]);

  return null;
}
