/**
 * Providers route — the PCP list the roster's panel filter is populated from (spec §5).
 *
 *   GET /api/providers → { id, name, location }[]
 *
 * Read-only, and authenticated like the other directory routes (the /api/** catch-all GET →
 * AUTHENTICATED). Profile-scoped: on the Maui deployment this is the pilot's 40 primary-care
 * providers; on the default profile it is the occupational directory's clinicians.
 *
 * `tenantId` is deliberately NOT returned. The filter matches on `id`, the select renders `name` and
 * groups by `location`, and a field nothing reads is a field that drifts.
 */
import { providers } from "../config/deployment-profile.ts";

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

export async function handleProviders(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (new URL(req.url).pathname !== "/api/providers") return null;
  // Sorted by location then name so the select renders grouped and stable — the directory's own order
  // is insertion order, which would reshuffle the dropdown whenever the table is edited.
  const rows = [...providers()]
    .map((p) => ({ id: p.id, name: p.name, location: p.location }))
    .sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));
  return json(rows);
}
