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
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import type { SegmentRule, SegmentOverride } from "../stores/segment-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";

interface SegmentsEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const bad = (message: string): Response => json({ error: "invalid_request", message }, 400);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validate measureIds: a string[] of known runnable measure ids. Returns an error message, or null. */
function validateMeasureIds(v: unknown): string | null {
  if (!isStringArray(v)) return "measureIds must be an array of strings";
  const unknown = v.filter((id) => !(id in MEASURES));
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
    if (typeof c.value !== "string" && !isStringArray(c.value)) return "condition.value must be a string or string[]";
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
    const members = EMPLOYEES.filter((e) => matchesCohort(e, seg)).map((e) => e.externalId);
    return json({ count: members.length, members });
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

    const created = await store.createSegment({
      name: body.name,
      description: typeof body.description === "string" ? body.description : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      rule: body.rule as SegmentRule,
      measureIds: body.measureIds as string[],
      overrides: body.overrides as SegmentOverride[] | undefined,
    });
    await audit(stores.events, "SEGMENT_CREATED", created.id, actor, { name: created.name, measureIds: created.measureIds });
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

    const patched = await store.updateSegment(putId, {
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      enabled: body.enabled as boolean | undefined,
      rule: body.rule as SegmentRule | undefined,
    });
    if (!patched) return json({ error: "not_found", message: `Segment not found: ${putId}` }, 404);
    if (body.measureIds !== undefined) await store.setMeasures(putId, body.measureIds as string[]);
    if (body.overrides !== undefined) await store.setOverrides(putId, body.overrides as SegmentOverride[]);

    const hydrated = await store.getSegment(putId);
    await audit(stores.events, "SEGMENT_UPDATED", putId, actor, {
      name: hydrated?.name,
      enabled: hydrated?.enabled,
      measureIds: hydrated?.measureIds,
    });
    return json(hydrated);
  }

  // DELETE /api/segments/:id
  const delId = req.method === "DELETE" ? pathname.match(/^\/api\/segments\/([^/]+)$/)?.[1] : undefined;
  if (delId) {
    const seg = await store.getSegment(delId);
    if (!seg) return json({ error: "not_found", message: `Segment not found: ${delId}` }, 404);
    await store.deleteSegment(delId);
    await audit(stores.events, "SEGMENT_DELETED", delId, actor, { name: seg.name });
    return new Response(null, { status: 204 });
  }

  return null;
}
