/**
 * Hierarchy route (#74 E4) — the multi-level dashboard rollup behind the unchanged frontend
 * contract. Authenticated under /api/** by the worker's security matrix.
 *
 *   GET /api/hierarchy/rollup?measureId=&from=&to=&tenant=  → HierarchyNode (All-Systems root,
 *     or the given tenant's subtree when ?tenant= is set; #185 E13 PR-1)
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { buildHierarchyRollup } from "../program/hierarchy-rollup.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";

interface HierarchyEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleHierarchy(req: Request, env: HierarchyEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/hierarchy/rollup") return null;

  const q = url.searchParams;
  let from: string | undefined;
  let to: string | undefined;
  try {
    from = parseQueryDate(q.get("from"), "from");
    to = parseQueryDate(q.get("to"), "to");
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }
  const s = await getStores(env);
  const tree = await buildHierarchyRollup(
    {
      outcomeStore: s.outcomes,
      caseStore: s.cases,
      runStore: s.runs,
      webChartEnv: env,
    },
    { measureId: q.get("measureId"), from, to, tenant: q.get("tenant") },
  );
  return json(tree);
}
