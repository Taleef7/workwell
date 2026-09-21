/**
 * Segments route (#183 E11.3): POST/GET/PUT/DELETE CRUD + GET :id/preview, 400 on malformed bodies.
 *   node --import tsx --test src/routes/segments.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { handleSegments } from "./segments.ts";

const dbPath = join(tmpdir(), `workwell-segroute-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const actor = "admin";

const post = (body: unknown) =>
  handleSegments(new Request("http://x/api/segments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env as never, actor);
const put = (id: string, body: unknown) =>
  handleSegments(new Request(`http://x/api/segments/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env as never, actor);
const del = (id: string) =>
  handleSegments(new Request(`http://x/api/segments/${id}`, { method: "DELETE" }), env as never, actor);
const getList = () => handleSegments(new Request("http://x/api/segments", { method: "GET" }), env as never, actor);
const getPreview = (id: string) => handleSegments(new Request(`http://x/api/segments/${id}/preview`, { method: "GET" }), env as never, actor);

const welderRule = { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] };

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("POST creates a segment; GET list round-trips it", async () => {
  const res = await post({ name: "Welders", rule: welderRule, measureIds: ["audiogram"] });
  assert.equal(res?.status, 201);
  const created = (await res!.json()) as { id: string; name: string; measureIds: string[] };
  assert.equal(created.name, "Welders");
  assert.deepEqual(created.measureIds, ["audiogram"]);
  assert.ok(created.id);

  const list = (await getList().then((r) => r!.json())) as Array<{ id: string }>;
  assert.ok(list.some((s) => s.id === created.id));
});

test("GET :id/preview returns count > 0 for a role-contains-Welder rule", async () => {
  const created = (await post({ name: "Welders Preview", rule: welderRule, measureIds: ["audiogram"] }).then((r) => r!.json())) as { id: string };
  const res = await getPreview(created.id);
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { count: number; members: string[] };
  assert.ok(body.count > 0, "expected real directory Welders to match");
  assert.equal(body.count, body.members.length);
  assert.ok(body.members.includes("emp-006"), "emp-006 (Welder) should be a member");
});

test("GET :id/preview → 404 for an unknown segment", async () => {
  assert.equal((await getPreview("nope"))?.status, 404);
});

test("PUT updates enabled + measureIds and re-reads them", async () => {
  const created = (await post({ name: "Upd", rule: welderRule, measureIds: ["audiogram"], enabled: true }).then((r) => r!.json())) as { id: string };
  const res = await put(created.id, { enabled: false, measureIds: ["audiogram", "flu_vaccine"] });
  assert.equal(res?.status, 200);
  const updated = (await res!.json()) as { enabled: boolean; measureIds: string[] };
  assert.equal(updated.enabled, false);
  assert.deepEqual([...updated.measureIds].sort(), ["audiogram", "flu_vaccine"]);
});

test("PUT accepts an official-only catalog measure (no authored entry) — the pilot's routed set (issue #536)", async () => {
  const created = (await post({ name: "Pilot", rule: welderRule, measureIds: ["cms122"] }).then((r) => r!.json())) as { id: string };
  const res = await put(created.id, { measureIds: ["cms122", "cms2", "cms130", "cms165", "cms137"] });
  assert.equal(res!.status, 200, "cms2/cms130/cms165/cms137 are catalog measures with no authored CQL; the segment may name them");
  const updated = (await res!.json()) as { measureIds: string[] };
  assert.deepEqual([...updated.measureIds].sort(), ["cms122", "cms130", "cms137", "cms165", "cms2"]);
  assert.equal((await put(created.id, { measureIds: ["cms2", "not_a_real_measure"] }))?.status, 400, "an id in neither registry nor catalog is still refused");
});

test("PUT → 404 for an unknown segment", async () => {
  assert.equal((await put("nope", { name: "x" }))?.status, 404);
});

test("DELETE returns 204 and the segment is gone (preview → 404)", async () => {
  const created = (await post({ name: "Doomed", rule: welderRule, measureIds: ["audiogram"] }).then((r) => r!.json())) as { id: string };
  const res = await del(created.id);
  assert.equal(res?.status, 204);
  assert.equal((await getPreview(created.id))?.status, 404);
});

test("DELETE → 404 for an unknown segment", async () => {
  assert.equal((await del("nope"))?.status, 404);
});

test("malformed POST → 400", async () => {
  // missing name
  assert.equal((await post({ rule: welderRule, measureIds: ["audiogram"] }))?.status, 400);
  // bad rule.match
  assert.equal((await post({ name: "x", rule: { match: "MAYBE", conditions: [] }, measureIds: [] }))?.status, 400);
  // bad condition attr
  assert.equal((await post({ name: "x", rule: { match: "ANY", conditions: [{ attr: "wat", op: "equals", value: "a" }] }, measureIds: [] }))?.status, 400);
  // bad condition op
  assert.equal((await post({ name: "x", rule: { match: "ANY", conditions: [{ attr: "role", op: "BOGUS", value: "a" }] }, measureIds: [] }))?.status, 400);
  // measureIds not an array of strings
  assert.equal((await post({ name: "x", rule: welderRule, measureIds: [1, 2] }))?.status, 400);
  // unknown measure id (not in the runnable registry)
  assert.equal((await post({ name: "x", rule: welderRule, measureIds: ["not_a_real_measure"] }))?.status, 400);
  // op/value shape mismatch — `in` needs a string[], equals/contains need a string (else it silently matches nobody)
  assert.equal((await post({ name: "x", rule: { match: "ANY", conditions: [{ attr: "site", op: "in", value: "Clinic" }] }, measureIds: ["audiogram"] }))?.status, 400);
  assert.equal((await post({ name: "x", rule: { match: "ANY", conditions: [{ attr: "role", op: "equals", value: ["Welder"] }] }, measureIds: ["audiogram"] }))?.status, 400);
  // bad override mode
  assert.equal((await post({ name: "x", rule: welderRule, measureIds: ["audiogram"], overrides: [{ externalId: "emp-006", mode: "BOGUS" }] }))?.status, 400);
});

test("cold DB: first GET /api/segments auto-seeds the demo cohorts (not just via /api/measures)", async () => {
  const p = join(tmpdir(), `workwell-segroute-cold-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(p);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const coldEnv = { DB: db } as never;
  try {
    // No prior /api/measures call — the very first segment read must still see the seeded cohorts.
    const list = (await handleSegments(new Request("http://x/api/segments", { method: "GET" }), coldEnv, actor).then((r) => r!.json())) as Array<{ name: string }>;
    const names = list.map((s) => s.name);
    assert.ok(names.includes("All Employees"), "demo cohorts seeded on a cold-DB segment read");
    assert.ok(names.includes("OSHA Safety-Sensitive"));
  } finally {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

test("malformed PUT (bad rule) → 400", async () => {
  const created = (await post({ name: "PutValidate", rule: welderRule, measureIds: ["audiogram"] }).then((r) => r!.json())) as { id: string };
  assert.equal((await put(created.id, { rule: { match: "MAYBE", conditions: [] } }))?.status, 400);
});

test("non-segment path → handler returns null", async () => {
  assert.equal(await handleSegments(new Request("http://x/api/cases", { method: "GET" }), env as never, actor), null);
});

test("POST /api/segments/preview returns count + members for an unsaved rule", async () => {
  const res = await handleSegments(
    new Request("http://x/api/segments/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: welderRule, overrides: [] }) }),
    env as never, actor,
  );
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { count: number; members: string[] };
  assert.ok(body.count > 0, "the Welder rule matches real directory members");
  assert.equal(body.count, body.members.length);
  assert.ok(body.members.includes("emp-006"), "emp-006 (Welder) is a member");
});

test("POST /api/segments/preview applies overrides (EXCLUDE removes a rule match)", async () => {
  const res = await handleSegments(
    new Request("http://x/api/segments/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: welderRule, overrides: [{ externalId: "emp-006", mode: "EXCLUDE" }] }) }),
    env as never, actor,
  );
  const body = (await res!.json()) as { members: string[] };
  assert.ok(!body.members.includes("emp-006"), "EXCLUDE override drops emp-006");
});

test("POST /api/segments/preview applies overrides (INCLUDE adds a non-rule-matching member)", async () => {
  // emp-007 (Sana Imtiaz, "Office Staff") does NOT satisfy welderRule (role contains "Welder").
  const res = await handleSegments(
    new Request("http://x/api/segments/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: welderRule, overrides: [{ externalId: "emp-007", mode: "INCLUDE" }] }) }),
    env as never, actor,
  );
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { members: string[] };
  assert.ok(body.members.includes("emp-007"), "INCLUDE override adds emp-007 despite not matching the rule");
});

test("POST /api/segments/preview → { count: 0, members: [] } for a rule matching nobody", async () => {
  const res = await handleSegments(
    new Request("http://x/api/segments/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: { match: "ANY", conditions: [{ attr: "role", op: "equals", value: "Nonexistent Role" }] }, overrides: [] }) }),
    env as never, actor,
  );
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { count: number; members: string[] };
  assert.equal(body.count, 0);
  assert.deepEqual(body.members, []);
});

test("POST /api/segments/preview → 400 on a malformed rule (op/value shape)", async () => {
  const res = await handleSegments(
    new Request("http://x/api/segments/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: { match: "ANY", conditions: [{ attr: "site", op: "in", value: "Clinic" }] } }) }),
    env as never, actor,
  );
  assert.equal(res?.status, 400);
});

/**
 * The audit-first half of #598 for this route. The ORDER is not reachable from outside — the route
 * resolves its stores from `env` rather than taking them injected, so no test here can make the insert
 * fail and watch the event survive (`src/audit/audit-order.test.ts` does that for the injectable
 * services). What IS reachable is the enabling change, and the way it could regress silently: mint an
 * id for the event and let the store mint its own, leaving every SEGMENT_CREATED event pointing at a
 * segment that never existed.
 */
test("SEGMENT_CREATED names the id the segment is created under (#598)", async () => {
  const res = await post({ name: "Audit-order welders", rule: welderRule, measureIds: ["audiogram"] });
  assert.equal(res?.status, 201);
  const created = (await res!.json()) as { id: string; name: string };
  const row = await (env.DB as { prepare: (s: string) => { bind: (...a: unknown[]) => { first: <T>() => Promise<T | null> } } })
    .prepare("SELECT entity_id, entity_type, payload_json FROM audit_events WHERE event_type = 'SEGMENT_CREATED' AND entity_id = ?")
    .bind(created.id)
    .first<{ entity_id: string; entity_type: string; payload_json: string }>();
  assert.ok(row, "the event names the created segment, not an id the store discarded");
  assert.equal(row!.entity_type, "segment");
  assert.equal((JSON.parse(row!.payload_json) as { name: string }).name, "Audit-order welders");
});

test("SEGMENT_UPDATED reports the post-state resolved from the pre-state and the request (#598)", async () => {
  // The payload used to come from a re-read AFTER the three writes, which is what forced the audit to
  // come second. It is now merged from the row as it was plus the fields the request carries — so a
  // PARTIAL body must still report the unchanged fields, not drop them.
  const created = (await (await post({ name: "Before", rule: welderRule, measureIds: ["audiogram"] }))!.json()) as { id: string };
  const res = await put(created.id, { name: "After" }); // name only: measureIds and enabled are untouched
  assert.equal(res?.status, 200);
  const row = await (env.DB as { prepare: (s: string) => { bind: (...a: unknown[]) => { first: <T>() => Promise<T | null> } } })
    .prepare("SELECT payload_json FROM audit_events WHERE event_type = 'SEGMENT_UPDATED' AND entity_id = ?")
    .bind(created.id)
    .first<{ payload_json: string }>();
  assert.ok(row);
  const payload = JSON.parse(row!.payload_json) as { name: string; enabled: boolean; measureIds: string[] };
  assert.equal(payload.name, "After", "the requested change");
  assert.deepEqual(payload.measureIds, ["audiogram"], "and the fields the request did not mention");
  assert.equal(payload.enabled, true);
});

test("DELETE audits before the row goes, and a missing segment is still a 404 with no event (#598)", async () => {
  const created = (await (await post({ name: "Doomed", rule: welderRule, measureIds: [] }))!.json()) as { id: string };
  assert.equal((await del(created.id))?.status, 204);
  const q = (env.DB as { prepare: (s: string) => { bind: (...a: unknown[]) => { first: <T>() => Promise<T | null> } } });
  const row = await q
    .prepare("SELECT payload_json FROM audit_events WHERE event_type = 'SEGMENT_DELETED' AND entity_id = ?")
    .bind(created.id)
    .first<{ payload_json: string }>();
  assert.equal((JSON.parse(row!.payload_json) as { name: string }).name, "Doomed", "the name is read off the row before it is deleted");
  // An unknown id refuses before it audits — an over-claim is the side the rule picks, but only for a
  // change somebody actually asked for.
  assert.equal((await del("00000000-0000-4000-8000-000000000000"))?.status, 404);
  const none = await q
    .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'SEGMENT_DELETED' AND entity_id = ?")
    .bind("00000000-0000-4000-8000-000000000000")
    .first<{ n: number }>();
  assert.equal(Number(none!.n), 0);
});
