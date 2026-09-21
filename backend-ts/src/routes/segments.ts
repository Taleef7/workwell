/**
 * Segments route (#183 E11.3) — risk-group CRUD + a membership preview. Writes (POST/PUT/DELETE) are
 * ADMIN-gated in authorize.ts; GET list + preview fall through to AUTHENTICATED. Every write emits a
 * SEGMENT_* audit event (CLAUDE.md hard rule). Segments configure applicability only — never compliance
 * (ADR-016).
 *
 *   GET    /api/segments                 → HydratedSegment[]
 *   GET    /api/segments/:id/preview     → { count, members: externalId[] }
 *   POST   /api/segments                 → 201 HydratedSegment   (+ SEGMENT_CREATED)
 *   PUT    /api/segments/:id             → 200 HydratedSegment   (+ SEGMENT_UPDATED) | 404
 *   DELETE /api/segments/:id             → 204                   (+ SEGMENT_DELETED) | 404
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { matchesCohort } from "../segment/segment-applicability.ts";
import { ensureSegmentSeed } from "../segment/segment-seed.ts";
// The PROFILE-SCOPED directory, not the raw catalog: `previewResponse` returns member
// `externalId`s to the client, so on a scoped deployment the raw list would hand a user the OTHER
// deployment's subject identifiers. Same class as the roster leak — a read that reaches the full
// directory through a path a catalog-import sweep does not obviously cover.
import { employees } from "../config/deployment-profile.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import type { SegmentRule, SegmentOverride, HydratedSegment } from "../stores/segment-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";

interface SegmentsEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const bad = (message: string): Response => json({ error: "invalid_request", message }, 400);

/**
 * The measure list AS THE ROW WILL HOLD IT — deduped and ordered.
 *
 * `setMeasures` inserts `[...new Set(measureIds)]` and `hydrate` reads back `ORDER BY measure_id ASC`,
 * so a payload built from the request array can name a list the segment never contained. That did not
 * matter while the audit came second (it reported the hydrated value); it does now that the event is
 * written first, and it is a payload-accuracy regression in the direction #598 exists to close.
 */
const storedMeasureIds = (measureIds: readonly string[]): string[] => [...new Set(measureIds)].sort();

/** Shared membership-preview projection used by BOTH preview surfaces (GET :id/preview + POST /preview)
 *  so they can't drift: filter the directory through the canonical matchesCohort, return { count, members }. */
const previewResponse = (seg: HydratedSegment): Response => {
  const members = employees().filter((e) => matchesCohort(e, seg)).map((e) => e.externalId);
  return json({ count: members.length, members });
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validate measureIds: a string[] of known runnable measure ids. Returns an error message, or null. */
function validateMeasureIds(v: unknown): string | null {
  if (!isStringArray(v)) return "measureIds must be an array of strings";
  // A segment may name an ACTIVE catalog measure, not only an AUTHORED one: cms2, cms130, cms165 and
  // cms137 are official-only (no entry in `MEASURES`, the authored registry) and are the pilot's routed
  // set. Until 2026-09-10 this check refused them, so the live `All Patients` segment could not be
  // widened to the measures the sandbox runs (issue #536) — four of six measures evaluated and opened
  // no case. Draft and Deprecated catalog rows stay refused (a legacy row, ADR-071, is not a cohort's
  // measure); an authored id is accepted as it always was.
  const unknown = v.filter((id) => !(id in MEASURES) && !MEASURE_CATALOG.some((m) => m.id === id && m.status === "Active"));
  if (unknown.length) return `unknown measure id(s): ${unknown.join(", ")}`;
  return null;
}

const MATCHES = new Set(["ANY", "ALL"]);
const ATTRS = new Set(["role", "site"]);
const OPS = new Set(["equals", "contains", "in"]);
const MODES = new Set(["INCLUDE", "EXCLUDE"]);

/** Validate a rule object. Returns an error message, or null if valid. */
function validateRule(rule: unknown): string | null {
  if (!isObject(rule)) return "rule must be an object";
  if (typeof rule.match !== "string" || !MATCHES.has(rule.match)) return "rule.match must be ANY or ALL";
  if (!Array.isArray(rule.conditions)) return "rule.conditions must be an array";
  for (const c of rule.conditions) {
    if (!isObject(c)) return "each condition must be an object";
    if (typeof c.attr !== "string" || !ATTRS.has(c.attr)) return "condition.attr must be role or site";
    if (typeof c.op !== "string" || !OPS.has(c.op)) return "condition.op must be equals, contains, or in";
    // The value shape is operator-coupled: matchesRule only evaluates a string for equals/contains and a
    // string[] for `in`. Rejecting a mismatched shape here prevents a valid-looking condition that
    // silently matches nobody (and so silently disables applicability in preview/roster/case-gating).
    if (c.op === "in") {
      if (!isStringArray(c.value) || c.value.length === 0) return "condition.value must be a non-empty string[] when op is 'in'";
    } else if (typeof c.value !== "string" || c.value === "") {
      return `condition.value must be a non-empty string when op is '${c.op}'`;
    }
  }
  return null;
}

/** Validate an overrides array. Returns an error message, or null if valid (or absent). */
function validateOverrides(overrides: unknown): string | null {
  if (overrides === undefined) return null;
  if (!Array.isArray(overrides)) return "overrides must be an array";
  for (const o of overrides) {
    if (!isObject(o)) return "each override must be an object";
    if (typeof o.externalId !== "string") return "override.externalId must be a string";
    if (typeof o.mode !== "string" || !MODES.has(o.mode)) return "override.mode must be INCLUDE or EXCLUDE";
  }
  return null;
}

async function audit(
  events: CaseEventStore,
  eventType: string,
  id: string,
  actor: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await events.appendAudit({
    eventType,
    entityType: "segment",
    entityId: id,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload,
  });
}

export async function handleSegments(req: Request, env: SegmentsEnv, actor: string): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (pathname !== "/api/segments" && !pathname.startsWith("/api/segments/")) return null;

  // POST /api/segments/preview — dry-run membership for an UNSAVED rule (the editor's live preview).
  // Genuinely stateless: reads only the request body + the in-memory directory, so it runs ABOVE the
  // seed/store init and never pays for them. Reuses the exact validateRule + matchesCohort (via
  // previewResponse), so the preview can never drift from real applicability. ADMIN-gated by the
  // existing POST /api/segments/** rule. Read-only; no audit.
  if (req.method === "POST" && pathname === "/api/segments/preview") {
    const body = (await req.json().catch(() => ({}))) as { rule?: unknown; overrides?: unknown };
    const ruleErr = validateRule(body.rule);
    if (ruleErr) return bad(ruleErr);
    const overrideErr = validateOverrides(body.overrides);
    if (overrideErr) return bad(overrideErr);
    return previewResponse({
      id: "preview", name: "preview", description: "", enabled: true,
      rule: body.rule as SegmentRule, measureIds: [],
      overrides: (body.overrides ?? []) as SegmentOverride[],
      createdBy: "", createdAt: "", updatedAt: "",
    });
  }

  await ensureSegmentSeed(env);
  const stores = await getStores(env);
  const store = stores.segments;

  // GET /api/segments
  if (req.method === "GET" && pathname === "/api/segments") {
    return json(await store.listSegments());
  }

  // GET /api/segments/:id/preview — "who would this cohort match?" for the authoring editor. Intentionally
  // ignores `enabled` (it previews membership regardless of whether the segment is live), unlike the
  // applicability overlay/gate which only count enabled segments.
  const previewId = req.method === "GET" ? pathname.match(/^\/api\/segments\/([^/]+)\/preview$/)?.[1] : undefined;
  if (previewId) {
    const seg = await store.getSegment(previewId);
    if (!seg) return json({ error: "not_found", message: `Segment not found: ${previewId}` }, 404);
    return previewResponse(seg);
  }

  // POST /api/segments
  if (req.method === "POST" && pathname === "/api/segments") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.name !== "string" || body.name.trim() === "") return bad("name is required");
    const ruleErr = validateRule(body.rule);
    if (ruleErr) return bad(ruleErr);
    const measureErr = validateMeasureIds(body.measureIds);
    if (measureErr) return bad(measureErr);
    const overrideErr = validateOverrides(body.overrides);
    if (overrideErr) return bad(overrideErr);

    // AUDIT BEFORE MUTATE (#598). The id is minted HERE rather than by the insert — the store now
    // accepts one — so the event can name the segment before it exists. The payload's two values come
    // from the REQUEST rather than from the created row: they are the same values the insert is about
    // to store, and reading them off the result is what forced the old order.
    const id = crypto.randomUUID();
    const name = body.name as string;
    const measureIds = body.measureIds as string[];
    // DEDUPED, because that is what the row will hold: `setMeasures` writes `[...new Set(...)]` and
    // `hydrate` reads back ordered by `measure_id`. Reporting the request array verbatim made the event
    // describe something the segment never contained — which is a payload-accuracy regression in the
    // direction this whole change exists to close (review of #612). `storedMeasureIds` is the one place
    // the two agree.
    await audit(stores.events, "SEGMENT_CREATED", id, actor, { name, measureIds: storedMeasureIds(measureIds) });
    const created = await store.createSegment({
      id,
      name,
      description: typeof body.description === "string" ? body.description : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      rule: body.rule as SegmentRule,
      measureIds,
      overrides: body.overrides as SegmentOverride[] | undefined,
    });
    return json(created, 201);
  }

  // PUT /api/segments/:id
  const putId = req.method === "PUT" ? pathname.match(/^\/api\/segments\/([^/]+)$/)?.[1] : undefined;
  if (putId) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim() === "")) return bad("name must be a non-empty string");
    if (body.description !== undefined && typeof body.description !== "string") return bad("description must be a string");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return bad("enabled must be a boolean");
    if (body.rule !== undefined) {
      const ruleErr = validateRule(body.rule);
      if (ruleErr) return bad(ruleErr);
    }
    if (body.measureIds !== undefined) {
      const measureErr = validateMeasureIds(body.measureIds);
      if (measureErr) return bad(measureErr);
    }
    const overrideErr = validateOverrides(body.overrides);
    if (overrideErr) return bad(overrideErr);

    // AUDIT BEFORE MUTATE (#598), and it needed THREE writes moved, not one: `updateSegment` was
    // followed by `setMeasures` and `setOverrides`, so a failure after the first left a partly-updated
    // segment with no event at all.
    //
    // The 404 moved to an explicit pre-read. `updateSegment` returning null WAS the not-found signal,
    // which is exactly what made the old order unavoidable: the route could not know the segment
    // existed until it had already tried to change it. The pre-read leaves a window in which the row
    // could vanish between the check and the write — an event for a change that then did not happen,
    // which is the side #598's rule deliberately picks.
    if (!(await store.getSegment(putId))) return json({ error: "not_found", message: `Segment not found: ${putId}` }, 404);
    // **The payload is what THIS REQUEST CHANGES, not the resulting state** (Codex, #612).
    //
    // The first cut merged the request over a pre-read, so it reported a post-state — and under two
    // concurrent admins that post-state is a guess: read `enabled: true`, let the other request set it
    // false, change only the name, and `updateSegment` preserves the newer false while the event says
    // true. The old post-write hydration could not be wrong about that, because it re-read; an
    // audit-first event cannot re-read, so it must not claim the parts it does not set.
    //
    // A consumer wanting the resulting state reads the row. What the ledger is FOR is who changed what,
    // and every field here is one this request supplies — knowable before the write and true after it.
    const changes: Record<string, unknown> = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.description !== undefined) changes.description = body.description;
    if (body.enabled !== undefined) changes.enabled = body.enabled;
    if (body.rule !== undefined) changes.rule = body.rule;
    // Deduped for the same reason as the create above: it is what the row will hold.
    if (body.measureIds !== undefined) changes.measureIds = storedMeasureIds(body.measureIds as string[]);
    if (body.overrides !== undefined) changes.overrides = body.overrides;
    await audit(stores.events, "SEGMENT_UPDATED", putId, actor, { changed: Object.keys(changes).sort(), ...changes });
    // **`patched` is still checked, and dropping that check was a real regression** (review of #612).
    // The pre-read covers the ordinary not-found; this null covers the row VANISHING between the two,
    // and it guarded the two writes below as well. Without it a concurrent delete gave either a 500
    // (`setMeasures` violating the `segment_measures` foreign key) or an HTTP 200 whose body is
    // `null` — a client doing `(await res.json()).id` gets a TypeError on a success. The old order
    // returned a clean 404 for both, and the audit-first reorder must not cost that.
    const patched = await store.updateSegment(putId, {
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      enabled: body.enabled as boolean | undefined,
      rule: body.rule as SegmentRule | undefined,
    });
    if (!patched) return json({ error: "not_found", message: `Segment not found: ${putId}` }, 404);
    if (body.measureIds !== undefined) await store.setMeasures(putId, body.measureIds as string[]);
    if (body.overrides !== undefined) await store.setOverrides(putId, body.overrides as SegmentOverride[]);
    return json(await store.getSegment(putId));
  }

  // DELETE /api/segments/:id
  const delId = req.method === "DELETE" ? pathname.match(/^\/api\/segments\/([^/]+)$/)?.[1] : undefined;
  if (delId) {
    const seg = await store.getSegment(delId);
    if (!seg) return json({ error: "not_found", message: `Segment not found: ${delId}` }, 404);
    // AUDIT BEFORE MUTATE (#598) — a plain reorder here: the id and the name both come from the row
    // already read, so nothing the event needs is minted by the delete.
    await audit(stores.events, "SEGMENT_DELETED", delId, actor, { name: seg.name });
    await store.deleteSegment(delId);
    return new Response(null, { status: 204 });
  }

  return null;
}
