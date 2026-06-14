/**
 * Cases route (#107 cases module) — the worklist read behind the unchanged frontend
 * contract (`CaseSummary[]`). Cases are upserted from run outcomes (run pipeline);
 * this serves the worklist with the page's status/measure/priority/assignee/site/
 * search filters + limit/offset paging.
 *
 *   GET /api/cases   newest-first case summaries (filtered)   → 200 CaseSummary[]
 *
 * Actions (assign/escalate/outreach), case detail, and timeline are later slices.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { toCaseSummary, type CaseSummary } from "../case/case-read-models.ts";

interface CasesEnv {
  DB: CloudDatabase;
}

const ready = new WeakSet<object>();
async function caseStore(env: CasesEnv): Promise<SqliteCaseStore> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    ready.add(env.DB);
  }
  return new SqliteCaseStore(env.DB);
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Map the page's status filter to concrete case statuses (undefined = all). */
function statusesFor(raw: string | null): string[] | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "":
    case "all":
      return undefined;
    case "open":
      return ["OPEN"];
    case "closed":
      return ["RESOLVED", "CLOSED"];
    case "excluded":
      return ["EXCLUDED"];
    default:
      return [(raw as string).toUpperCase()];
  }
}

export async function handleCases(req: Request, env: CasesEnv): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/cases" || req.method !== "GET") return null;

  const q = url.searchParams;
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? "50") || 50));
  const offset = Math.max(0, Number(q.get("offset") ?? "0") || 0);
  const site = q.get("site")?.trim() || undefined;
  const search = q.get("search")?.trim().toLowerCase() || undefined;

  const store = await caseStore(env);
  // Fetch all rows matching the SQL-filterable predicates, then post-filter site/search
  // (employee-derived, not stored) and page in the read model — correct paging at floor scale.
  const rows = await store.listCases({
    statuses: statusesFor(q.get("status")),
    measureId: q.get("measureId") ?? undefined,
    priority: q.get("priority") ?? undefined,
    assignee: q.get("assignee") ?? undefined,
    limit: 100000,
    offset: 0,
  });

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
