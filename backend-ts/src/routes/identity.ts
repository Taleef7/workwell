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
import type { PersonLinkRef, PersonLinkType } from "../stores/person-link-store.ts";

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

export async function handleIdentity(req: Request, env: IdentityEnv, actor: string): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/identity/")) return null;

  // POST /api/identity/people/:personId/reconcile — confirm/break an identity link (E15 PR-2).
  if (req.method === "POST") {
    const rid = /^\/api\/identity\/people\/([^/]+)\/reconcile$/.exec(path)?.[1];
    if (!rid) return null;
    return reconcile(req, env, actor, decodeURIComponent(rid));
  }
  if (req.method !== "GET") return null;

  const q = url.searchParams;
  const tenant = q.get("tenant");
  const s = await getStores(env);
  const links = await s.personLinks.listLinks();

  // GET /api/identity/duplicates
  if (path === "/api/identity/duplicates") {
    let dups = duplicateCandidates(undefined, links);
    if (tenant) dups = dups.filter((p) => inTenant(p, tenant));
    return json(dups);
  }

  // GET /api/identity/people/:personId
  const detailId = /^\/api\/identity\/people\/([^/]+)$/.exec(path)?.[1];
  if (detailId) {
    const person = personById(decodeURIComponent(detailId), undefined, links);
    if (!person) return json({ error: "not_found", message: "person not found" }, 404);
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
    let people = resolvePeople(undefined, links).filter((p) => matchesQuery(p, queryStr));
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

/**
 * POST /api/identity/people/:personId/reconcile — confirm/break an identity link (E15 PR-2).
 * Body `{ action: "CONFIRM_LINK" | "UNLINK", tenantId, externalId }`. Persists a CONFIRMED/BROKEN pair
 * between the target record and the person's primary source (CONFIRM) or the person's other source
 * (UNLINK), audited `IDENTITY_LINK_CONFIRMED`/`IDENTITY_LINK_BROKEN`. Gated CASE_MANAGER/ADMIN by the
 * worker matrix. Descriptive only — the pair overrides read-time grouping, never `Outcome Status`.
 */
async function reconcile(req: Request, env: IdentityEnv, actor: string, personId: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { action?: string; tenantId?: string; externalId?: string };
  const action = body.action;
  const target: PersonLinkRef | null =
    body.tenantId && body.externalId ? { tenantId: body.tenantId, externalId: body.externalId } : null;
  if (action !== "CONFIRM_LINK" && action !== "UNLINK") {
    return json({ error: "invalid_request", message: "action must be CONFIRM_LINK or UNLINK" }, 400);
  }
  if (!target) return json({ error: "invalid_request", message: "tenantId and externalId are required" }, 400);

  const s = await getStores(env);
  const links = await s.personLinks.listLinks();
  const person = personById(personId, undefined, links);
  if (!person) return json({ error: "not_found", message: "person not found" }, 404);

  const isTarget = (ref: { tenantId: string; externalId: string }) =>
    ref.tenantId === target.tenantId && ref.externalId === target.externalId;

  let anchor: PersonLinkRef | undefined;
  let linkType: PersonLinkType;
  if (action === "CONFIRM_LINK") {
    // Attach the target to this person: pair it with the person's primary source. (No-op if it's already
    // a member — the same pair re-CONFIRMED is idempotent, and pairing a member with itself is rejected.)
    anchor = person.sources[0];
    linkType = "CONFIRMED";
  } else {
    // Split the target OUT of this person: the target must currently be a member; pair it (BROKEN) with
    // another of the person's sources so the direct edge is removed.
    if (!person.sources.some(isTarget)) {
      return json({ error: "invalid_request", message: "record is not part of this person" }, 400);
    }
    anchor = person.sources.find((sr) => !isTarget(sr));
    linkType = "BROKEN";
  }
  if (!anchor || isTarget(anchor)) {
    return json({ error: "invalid_request", message: "no distinct anchor record to link against" }, 400);
  }

  const link = await s.personLinks.upsertLink({
    a: { tenantId: anchor.tenantId, externalId: anchor.externalId },
    b: target,
    linkType,
    createdBy: actor,
  });
  await s.events.appendAudit({
    eventType: linkType === "CONFIRMED" ? "IDENTITY_LINK_CONFIRMED" : "IDENTITY_LINK_BROKEN",
    entityType: "person_link",
    entityId: link.id,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: { personId, action, anchor: link.a, target: link.b },
  });
  // Return the re-resolved person so the client reflects the new grouping immediately. The personId can
  // change when grouping changes (its canonical key shifts), so locate by membership of the anchor
  // record (which stays in the person for both CONFIRM and UNLINK) rather than by the old id.
  const after = resolvePeople(undefined, await s.personLinks.listLinks());
  const updated = after.find((p) => p.sources.some((sr) => sr.tenantId === anchor!.tenantId && sr.externalId === anchor!.externalId)) ?? null;
  return json({ action, link, person: updated }, 200);
}
