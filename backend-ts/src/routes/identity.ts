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
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { normalizePair, type PersonLinkRef } from "../stores/person-link-store.ts";

const refKey = (r: PersonLinkRef): string => `${r.tenantId}|${r.externalId}`;
const pairKeyOf = (a: PersonLinkRef, b: PersonLinkRef): string => {
  const n = normalizePair(a, b);
  return `${refKey(n.a)}::${refKey(n.b)}`;
};

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

/** decodeURIComponent that never throws — a malformed escape (`%zz`) must be a clean 404, not a 500
 *  (Fable L1: "unknown id → 404, never 500"). */
function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function handleIdentity(req: Request, env: IdentityEnv, actor: string): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/identity/")) return null;

  // POST /api/identity/people/:personId/reconcile — confirm/break an identity link (E15 PR-2).
  if (req.method === "POST") {
    const rid = /^\/api\/identity\/people\/([^/]+)\/reconcile$/.exec(path)?.[1];
    if (!rid) return null;
    const decoded = safeDecode(rid);
    if (decoded === null) return json({ error: "not_found", message: "person not found" }, 404);
    return reconcile(req, env, actor, decoded);
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
    const decodedId = safeDecode(detailId);
    const person = decodedId === null ? null : personById(decodedId, undefined, links);
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
 * Body `{ action: "CONFIRM_LINK" | "UNLINK", tenantId, externalId }`.
 *   CONFIRM_LINK — attach the (real) target record to this person (paired CONFIRMED with a distinct member).
 *   UNLINK — split the target fully OUT: it must be a member, and it's broken against EVERY other member
 *            (not one anchor), so a 3+ member component removes exactly the target and never ejects the
 *            wrong record.
 * Audited `IDENTITY_LINK_CONFIRMED`/`IDENTITY_LINK_BROKEN` (semantic anchor/target, not normalized order).
 * Gated CASE_MANAGER/ADMIN by the worker matrix. Descriptive only — overrides read-time grouping, never
 * `Outcome Status`.
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
  const audit = async (eventType: string, id: string, payload: Record<string, unknown>): Promise<void> => {
    await s.events.appendAudit({
      eventType, entityType: "person_link", entityId: id, actor,
      refRunId: null, refCaseId: null, refMeasureVersionId: null, payload,
    });
  };

  if (action === "CONFIRM_LINK") {
    // The target must be a real directory record — otherwise a typo persists a dangling link + audit row.
    const emp = employeeById(target.externalId);
    if (!emp || emp.tenantId !== target.tenantId) {
      return json({ error: "invalid_request", message: "target is not a known directory record" }, 400);
    }
    // Pair the target with a DISTINCT member of the person (its primary, unless that IS the target).
    const anchor = person.sources.find((sr) => !isTarget(sr));
    if (!anchor) return json({ error: "invalid_request", message: "no distinct record to link the target to" }, 400);
    const link = await s.personLinks.upsertLink({ a: anchor, b: target, linkType: "CONFIRMED", createdBy: actor });
    await audit("IDENTITY_LINK_CONFIRMED", link.id, { personId, action, anchor, target });
    const after = resolvePeople(undefined, await s.personLinks.listLinks());
    const updated = after.find((p) => p.sources.some((sr) => sr.tenantId === anchor.tenantId && sr.externalId === anchor.externalId)) ?? null;
    return json({ action, link, person: updated }, 200);
  }

  // UNLINK — the target must currently be a member; break it against EVERY other member so it splits out
  // fully regardless of which edge(s) held it (a single-anchor break could eject the wrong record).
  const others = person.sources.filter((sr) => !isTarget(sr));
  if (person.sources.length === others.length) {
    return json({ error: "invalid_request", message: "record is not part of this person" }, 400);
  }
  if (others.length === 0) return json({ error: "invalid_request", message: "cannot unlink the only source" }, 400);
  const brokenIds: string[] = [];
  for (const other of others) {
    const link = await s.personLinks.upsertLink({ a: other, b: target, linkType: "BROKEN", createdBy: actor });
    brokenIds.push(link.id);
  }
  await audit("IDENTITY_LINK_BROKEN", brokenIds[0]!, { personId, action, target, brokenAgainst: others, linkIds: brokenIds });

  // Re-assert survivor connectivity (Fable H8): if the target was the hub/anchor that transitively held
  // the survivors together (a star auto-edge OR the CONFIRM anchor — its edges are all now BROKEN),
  // breaking it can shatter survivors the human never spoke about. CONFIRM every survivor pair that is
  // NOT already explicitly BROKEN, so the survivors stay one person exactly as their own connectivity
  // allows — never overriding a split the human actually asserted (a broken survivor pair stays split).
  // These CONFIRMED writes are state changes, so they get their own audit event (Codex P2 — the
  // "every state change writes audit_event" hard rule applies to the survivor re-assert too).
  if (others.length > 1) {
    const linksNow = await s.personLinks.listLinks();
    const brokenPairs = new Set(linksNow.filter((l) => l.linkType === "BROKEN").map((l) => pairKeyOf(l.a, l.b)));
    const reasserted: Array<{ id: string; a: PersonLinkRef; b: PersonLinkRef }> = [];
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        const a = { tenantId: others[i]!.tenantId, externalId: others[i]!.externalId };
        const b = { tenantId: others[j]!.tenantId, externalId: others[j]!.externalId };
        if (!brokenPairs.has(pairKeyOf(a, b))) {
          const link = await s.personLinks.upsertLink({ a, b, linkType: "CONFIRMED", createdBy: actor });
          reasserted.push({ id: link.id, a, b });
        }
      }
    }
    if (reasserted.length > 0) {
      await audit("IDENTITY_LINK_CONFIRMED", reasserted[0]!.id, {
        personId, action, reason: "SURVIVOR_REASSERT", unlinked: target, pairs: reasserted.map(({ a, b }) => ({ a, b })),
        linkIds: reasserted.map((r) => r.id),
      });
    }
  }
  // The remaining members keep their grouping; return the person the target was split OUT of (located by
  // an untouched member, since the personId may change when grouping changes).
  const after = resolvePeople(undefined, await s.personLinks.listLinks());
  const survivor = others[0]!;
  const updated = after.find((p) => p.sources.some((sr) => sr.tenantId === survivor.tenantId && sr.externalId === survivor.externalId)) ?? null;
  return json({ action, brokenLinkIds: brokenIds, person: updated }, 200);
}
