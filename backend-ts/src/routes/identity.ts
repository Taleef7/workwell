/**
 * Cross-system identity routes (#187 E15 PR-1) — read-only person resolution over the multi-tenant
 * synthetic directory. Authenticated under /api/** by the worker's security matrix (all roles, read).
 *
 *   GET /api/identity/people?q=&tenant=&page=&pageSize=  → Person[] + X-Total-Count
 *       cross-system employee search (Doug's "employee search across systems"); q matches
 *       name/externalId/nationalId; tenant scopes to people with a link in that system.
 *   GET /api/identity/people/:personId  → { person, timeline: { entries, move } }
 *       the unified person view — compliance history across every linked system, time-ordered,
 *       with a mobility ("history continues from A → B as of D") annotation.
 *   GET /api/identity/duplicates?tenant=  → Person[]  (the DUPLICATE-badge worklist)
 *
 * Descriptive only — identity groups/follows, never decides compliance (ADR-008); the reconcile WRITE
 * path (confirm/unlink) is E15 PR-2, owner-gated. Unknown ids → 404/empty, never 500 (E13 parity).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { resolvePeople, duplicateCandidates, personById, type Person } from "../identity/identity-model.ts";
import { mergedComplianceTimeline, type TimelineOutcome } from "../identity/compliance-timeline.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

interface IdentityEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const intOr = (v: string | null, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt;
};

/** A person matches `q` if the query is a substring of the display name, any source name/externalId, or the nationalId. */
function matchesQuery(person: Person, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (person.displayName.toLowerCase().includes(needle)) return true;
  if (person.nationalId?.toLowerCase().includes(needle)) return true;
  return person.sources.some((s) => s.name.toLowerCase().includes(needle) || s.externalId.toLowerCase().includes(needle));
}

const inTenant = (person: Person, tenant: string): boolean => person.sources.some((s) => s.tenantId === tenant);

export async function handleIdentity(req: Request, env: IdentityEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/identity/")) return null;
  const q = url.searchParams;
  const tenant = q.get("tenant");

  // GET /api/identity/duplicates
  if (path === "/api/identity/duplicates") {
    let dups = duplicateCandidates();
    if (tenant) dups = dups.filter((p) => inTenant(p, tenant));
    return json(dups);
  }

  // GET /api/identity/people/:personId
  const detailId = /^\/api\/identity\/people\/([^/]+)$/.exec(path)?.[1];
  if (detailId) {
    const person = personById(decodeURIComponent(detailId));
    if (!person) return json({ error: "not_found", message: "person not found" }, 404);
    const s = await getStores(env);
    const outcomesByExternalId = new Map<string, TimelineOutcome[]>();
    for (const src of person.sources) {
      // Full per-source history (matches the employee-profile read) — a low cap would silently drop
      // older outcomes (e.g. after the weekly trend-history backfill), rendering "compliance history
      // (all systems)" incomplete. Demo-scale; the real read is paginated behind the E12 adapter (PR-3).
      const rows = await s.outcomes.listOutcomesForEmployee(src.externalId, 100000);
      outcomesByExternalId.set(
        src.externalId,
        rows.map((r) => ({ measureId: r.measureId, measureName: MEASURES[r.measureId]?.name, status: r.status, evaluatedAt: r.evaluatedAt })),
      );
    }
    return json({ person, timeline: mergedComplianceTimeline(person, outcomesByExternalId) });
  }

  // GET /api/identity/people  (search + paginate)
  if (path === "/api/identity/people") {
    const queryStr = q.get("q") ?? "";
    let people = resolvePeople().filter((p) => matchesQuery(p, queryStr));
    if (tenant) people = people.filter((p) => inTenant(p, tenant));
    // Cross-system people first (the interesting ones), then by display name — stable for paging.
    people.sort((a, b) => Number(b.crossSystem) - Number(a.crossSystem) || a.displayName.localeCompare(b.displayName));
    const total = people.length;
    const page = intOr(q.get("page"), 1);
    const pageSize = intOr(q.get("pageSize"), 50);
    const pageRows = people.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    return json(pageRows, 200, { "X-Total-Count": String(total) });
  }

  return null;
}
