/**
 * Cases route (#107 cases module) — the worklist read behind the unchanged frontend
 * contract (`CaseSummary[]`). Cases are upserted from run outcomes (run pipeline);
 * this serves the worklist with the page's status/measure/priority/assignee/site/
 * search filters + limit/offset paging.
 *
 *   GET /api/cases       newest-first case summaries (filtered)   → 200 CaseSummary[]
 *   GET /api/cases/:id   case detail + evidence/why_flagged       → 200 CaseDetail | 404
 *
 * Actions (assign/escalate/outreach) and the audit timeline are later slices
 * (CaseDetail.timeline is [] until the audit module is ported).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { toCaseSummary, type CaseSummary } from "../case/case-read-models.ts";
import { toCaseDetail } from "../case/case-detail-read-model.ts";

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

export async function handleCases(req: Request, env: CasesEnv): Promise<Response | null> {
  const url = new URL(req.url);

  // Case detail — the case row + its evidence (the outcome from the case's last run).
  const detailId = url.pathname.match(/^\/api\/cases\/([^/]+)$/)?.[1];
  if (detailId && req.method === "GET") {
    const c = await (await caseStore(env)).getCase(detailId);
    if (!c) return json({ error: "not_found", id: detailId }, 404);
    const outcomes = await (await outcomeStore(env)).listOutcomes(c.lastRunId);
    const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
    return json(toCaseDetail(c, outcome));
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
