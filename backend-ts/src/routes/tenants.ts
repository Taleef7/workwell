/**
 * Tenants route (#185 E13 PR-1) — lists the WebChart systems for the UI tenant selector.
 * Authenticated read-only under the /api/** matrix (the catch-all GET → AUTHENTICATED).
 *
 *   GET /api/tenants → { id, name }[]
 */
import { TENANTS } from "../engine/synthetic/employee-catalog.ts";

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

export async function handleTenants(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (new URL(req.url).pathname !== "/api/tenants") return null;
  return json(TENANTS.map((t) => ({ id: t.id, name: t.name })));
}
