/**
 * Cases route (#107 cases module) — the worklist read behind the unchanged frontend
 * contract (`CaseSummary[]`). Cases are upserted from run outcomes (run pipeline);
 * this serves the worklist with the page's status/measure/priority/assignee/site/
 * search filters + limit/offset paging.
 *
 *   GET  /api/cases             newest-first case summaries (filtered) → 200 CaseSummary[]
 *   GET  /api/cases/:id         case detail + evidence/why_flagged + timeline → 200 | 404
 *   POST /api/cases/:id/assign  ?assignee=…  set/clear the case owner    → 200 CaseDetail | 404
 *   POST /api/cases/:id/escalate              force HIGH/OPEN            → 200 CaseDetail | 404
 *   GET  /api/cases/:id/actions/outreach/preview ?templateId=…           → 200 OutreachPreview | 404
 *   POST /api/cases/:id/actions/outreach         ?templateId=…  send     → 200 CaseDetail | 404
 *   POST /api/cases/:id/actions/outreach/delivery ?deliveryStatus=…      → 200 CaseDetail | 400 | 404
 *
 * Each mutating action writes a case_action + an audit_event; the detail timeline is
 * the merged ledger. rerun-to-verify + evidence/appointments/ai are later slices.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { toCaseSummary, type CaseSummary } from "../case/case-read-models.ts";
import { toCaseDetail } from "../case/case-detail-read-model.ts";
import { assignCase, escalateCase, type CaseActionDeps } from "../case/case-actions.ts";
import { previewOutreach, sendOutreach, updateOutreachDelivery, OutreachError } from "../case/case-outreach.ts";

interface CasesEnv {
  DB: CloudDatabase;
}

const ready = new WeakSet<object>();
async function ensure(env: CasesEnv): Promise<void> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    ready.add(env.DB);
  }
}
async function caseStore(env: CasesEnv): Promise<SqliteCaseStore> {
  await ensure(env);
  return new SqliteCaseStore(env.DB);
}
async function outcomeStore(env: CasesEnv): Promise<SqliteOutcomeStore> {
  await ensure(env);
  return new SqliteOutcomeStore(env.DB);
}
async function actionDeps(env: CasesEnv): Promise<CaseActionDeps> {
  await ensure(env);
  return {
    cases: new SqliteCaseStore(env.DB),
    events: new SqliteCaseEventStore(env.DB),
    outcomes: new SqliteOutcomeStore(env.DB),
  };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * Map the page's status filter to concrete case statuses. Blank/missing defaults to
 * OPEN (matching the Java controller); `all` is the explicit unfiltered view.
 */
function statusesFor(raw: string | null): string[] | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "all":
      return undefined; // explicit: include every status
    case "closed":
      return ["RESOLVED", "CLOSED"];
    case "excluded":
      return ["EXCLUDED"];
    case "":
    case "open":
      return ["OPEN"]; // default
    default:
      return [(raw as string).toUpperCase()];
  }
}

/** Day portion (YYYY-MM-DD) for day-granular, inclusive from/to comparison. */
const day = (s: string): string => s.slice(0, 10);

export async function handleCases(req: Request, env: CasesEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);

  // Case actions (POST) — assign / escalate / outreach send / outreach delivery.
  if (req.method === "POST") {
    const assignId = url.pathname.match(/^\/api\/cases\/([^/]+)\/assign$/)?.[1];
    if (assignId) {
      const detail = await assignCase(await actionDeps(env), assignId, url.searchParams.get("assignee"), actor);
      return detail ? json(detail) : json({ error: "not_found", id: assignId }, 404);
    }
    const escalateId = url.pathname.match(/^\/api\/cases\/([^/]+)\/escalate$/)?.[1];
    if (escalateId) {
      const detail = await escalateCase(await actionDeps(env), escalateId, actor);
      return detail ? json(detail) : json({ error: "not_found", id: escalateId }, 404);
    }
    const deliveryId = url.pathname.match(/^\/api\/cases\/([^/]+)\/actions\/outreach\/delivery$/)?.[1];
    if (deliveryId) {
      try {
        const detail = await updateOutreachDelivery(
          await actionDeps(env),
          deliveryId,
          url.searchParams.get("deliveryStatus") ?? "",
          actor,
        );
        return detail ? json(detail) : json({ error: "not_found", id: deliveryId }, 404);
      } catch (err) {
        if (err instanceof OutreachError) return json({ error: "bad_request", message: err.message }, 400);
        throw err;
      }
    }
    const sendId = url.pathname.match(/^\/api\/cases\/([^/]+)\/actions\/outreach$/)?.[1];
    if (sendId) {
      const detail = await sendOutreach(await actionDeps(env), sendId, actor, url.searchParams.get("templateId"));
      return detail ? json(detail) : json({ error: "not_found", id: sendId }, 404);
    }
    return null; // other case POSTs (rerun/evidence/appointments) not ported yet
  }

  // Outreach preview (GET) — render the default template for the case (no state change).
  const previewId = url.pathname.match(/^\/api\/cases\/([^/]+)\/actions\/outreach\/preview$/)?.[1];
  if (previewId && req.method === "GET") {
    const preview = await previewOutreach(await actionDeps(env), previewId, url.searchParams.get("templateId"));
    return preview ? json(preview) : json({ error: "not_found", id: previewId }, 404);
  }

  // Case detail — the case row + its evidence (the outcome from the case's last run) + timeline.
  const detailId = url.pathname.match(/^\/api\/cases\/([^/]+)$/)?.[1];
  if (detailId && req.method === "GET") {
    const c = await (await caseStore(env)).getCase(detailId);
    if (!c) return json({ error: "not_found", id: detailId }, 404);
    const outcomes = await (await outcomeStore(env)).listOutcomes(c.lastRunId);
    const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
    const events = new SqliteCaseEventStore(env.DB);
    const timeline = await events.caseTimeline(detailId);
    const latest = await events.latestOutreachDeliveryStatus(detailId);
    return json(toCaseDetail(c, outcome, timeline, latest));
  }

  if (url.pathname !== "/api/cases" || req.method !== "GET") return null;

  const q = url.searchParams;
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? "50") || 50));
  const offset = Math.max(0, Number(q.get("offset") ?? "0") || 0);
  const site = q.get("site")?.trim() || undefined;
  const search = q.get("search")?.trim().toLowerCase() || undefined;
  const from = q.get("from")?.trim() || undefined;
  const to = q.get("to")?.trim() || undefined;

  const store = await caseStore(env);
  // Fetch all rows matching the SQL-filterable predicates, then post-filter the
  // record-derived ones (created_at range, employee site/search) and page in the read
  // model — correct paging at floor scale.
  let rows = await store.listCases({
    statuses: statusesFor(q.get("status")),
    measureId: q.get("measureId") ?? undefined,
    priority: q.get("priority") ?? undefined,
    assignee: q.get("assignee") ?? undefined,
    limit: 100000,
    offset: 0,
  });

  // from/to filter case creation time (day-granular, inclusive) — matches the Java route.
  if (from) rows = rows.filter((c) => day(c.createdAt) >= day(from));
  if (to) rows = rows.filter((c) => day(c.createdAt) <= day(to));

  let summaries: CaseSummary[] = rows.map(toCaseSummary);
  if (site) summaries = summaries.filter((c) => c.site === site);
  if (search) {
    summaries = summaries.filter(
      (c) =>
        c.employeeName.toLowerCase().includes(search) ||
        c.measureName.toLowerCase().includes(search) ||
        c.employeeId.toLowerCase().includes(search),
    );
  }
  return json(summaries.slice(offset, offset + limit));
}
