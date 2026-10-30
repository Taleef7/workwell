/**
 * Providers route — the PCP list the roster's panel filter is populated from (spec §5).
 *
 *   GET /api/providers      → { id, name, location }[]
 *   GET /api/providers/mine → { provider: { id, name, location } | null }
 *
 * Read-only, and authenticated like the other directory routes (the /api/** catch-all GET →
 * AUTHENTICATED). Profile-scoped: on the Maui deployment this is the pilot's 40 primary-care
 * providers; on the default profile it is the occupational directory's clinicians.
 *
 * `tenantId` is deliberately NOT returned. The filter matches on `id`, the select renders `name` and
 * groups by `location`, and a field nothing reads is a field that drifts.
 */
import { providers, providerById } from "../config/deployment-profile.ts";
import { DEMO_USERS, findDemoUser, type DemoUser } from "../auth/demo-users.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";

export interface LinkedProvider {
  id: string;
  name: string;
  location: string;
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

/**
 * The provider a clinician seat stands for (#870), or null. Only a ROLE_VIEWER account's link counts, and
 * only while the deployment's directory still lists the provider: a link to an id it no longer holds
 * resolves to nothing rather than to a row nobody can be counted under. `users` is the account list, a
 * parameter so the role rule can be tested against a record no real seat has.
 */
export function linkedProviderOf(
  email: string,
  env?: DataSourceEnv,
  users: readonly DemoUser[] = DEMO_USERS,
): LinkedProvider | null {
  const user = users === DEMO_USERS
    ? findDemoUser(email)
    : users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
  if (!user || user.role !== "ROLE_VIEWER" || !user.providerId) return null;
  const provider = providerById(user.providerId, env);
  return provider ? { id: provider.id, name: provider.name, location: provider.location } : null;
}

export async function handleProviders(req: Request, env?: DataSourceEnv, actor?: string): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const path = new URL(req.url).pathname;
  if (path === "/api/providers/mine") {
    // The signed-in account's own link, never anyone else's: there is no parameter to ask about another.
    return json({ provider: actor ? linkedProviderOf(actor, env) : null });
  }
  if (path !== "/api/providers") return null;
  // Sorted by location then name so the select renders grouped and stable — the directory's own order
  // is insertion order, which would reshuffle the dropdown whenever the table is edited.
  const rows = [...providers()]
    .map((p) => ({ id: p.id, name: p.name, location: p.location }))
    .sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));
  return json(rows);
}
