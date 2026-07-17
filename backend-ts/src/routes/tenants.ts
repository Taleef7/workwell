/**
 * Tenants route (#185 E13 PR-1) — lists the WebChart systems for the UI tenant selector.
 * Authenticated read-only under the /api/** matrix (the catch-all GET → AUTHENTICATED).
 *
 *   GET /api/tenants → { id, name }[]
 */
import { TENANTS, webChartTenant } from "../engine/synthetic/employee-catalog.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

export async function handleTenants(req: Request, env?: DataSourceEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (new URL(req.url).pathname !== "/api/tenants") return null;
  const live = env ? webChartTenant(env) : null;
  const tenants = live ? [...TENANTS, live] : TENANTS;
  return json(tenants.map((t) => ({ id: t.id, name: t.name })));
}
