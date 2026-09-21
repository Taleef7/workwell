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
// Patched per case to make a WRITE fail: the route resolves its own stores, so the prototype is the
// only seam — and it is enough to assert the ordering the comments claim.
import { SqliteSegmentStore } from "../stores/sqlite/segment-store-sqlite.ts";

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

/** The audit rows the #598 cases read, so each assertion is one line rather than five. */
const dbq = () => env.DB as {
  prepare: (sql: string) => { bind: (...a: unknown[]) => { first: <T>() => Promise<T | null> } };
};
const eventCount = async (eventType: string, entityId: string): Promise<number> =>
  Number((await dbq().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ? AND entity_id = ?").bind(eventType, entityId).first<{ n: number }>())!.n);
const eventPayload = async (eventType: string, entityId: string): Promise<unknown> =>
  JSON.parse((await dbq().prepare("SELECT payload_json FROM audit_events WHERE event_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1").bind(eventType, entityId).first<{ payload_json: string }>())!.payload_json);
const countSegments = async (id: string): Promise<number> =>
  Number((await dbq().prepare("SELECT COUNT(*) AS n FROM segments WHERE id = ?").bind(id).first<{ n: number }>())!.n);


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
 * The audit-first half of #598 for this route (#612 review).
 *
 * **The order IS reachable from here, and the first cut of this file said it was not.** The route
 * resolves its stores from `env`, so it cannot be handed a failing fake — but the store is a class, and
 * patching its prototype makes a write fail against the real fixture. Every case below that names an
 * order now asserts one: reverting the route to write-then-audit fails them. Before that correction all
 * three passed against the pre-change code, which is the shape of test this project keeps finding.
 *
 * The seam itself is covered separately and differently: `store-contract.ts` asserts the caller-minted
 * id is honoured on BOTH stores, because a route test on the SQLite floor cannot speak for the ceiling.
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

test("SEGMENT_UPDATED reports what THIS REQUEST changes, not the resulting state (#598)", async () => {
  // The payload came from a re-read AFTER the three writes, which is what forced the audit to come
  // second. The first audit-first cut replaced that with a pre-read merged under the request — a
  // post-state GUESS, and wrong under concurrency (Codex on #612): read `enabled: true`, let another
  // admin set it false, change only the name, and `updateSegment` preserves the newer false while the
  // event says true. An audit-first event cannot re-read, so it must not claim the parts it does not
  // set.
  const created = (await (await post({ name: "Before", rule: welderRule, measureIds: ["audiogram"] }))!.json()) as { id: string };
  assert.equal((await put(created.id, { name: "After" }))?.status, 200); // name only
  const payload = (await eventPayload("SEGMENT_UPDATED", created.id)) as Record<string, unknown>;
  assert.equal(payload.name, "After", "the field the request supplies");
  assert.deepEqual(payload.changed, ["name"], "and `changed` names exactly that set");
  for (const untouched of ["enabled", "measureIds", "rule", "description", "overrides"]) {
    assert.ok(!(untouched in payload), `${untouched} is ABSENT — the request said nothing about it`);
  }

  // The concurrency case itself, made deterministic: another writer flips `enabled` between this
  // request's pre-read and its write. The event must not have claimed a value for it.
  const raced = (await (await post({ name: "Raced", rule: welderRule, measureIds: [] }))!.json()) as { id: string };
  const realGet = SqliteSegmentStore.prototype.getSegment;
  let flipped = false;
  SqliteSegmentStore.prototype.getSegment = async function racy(this: SqliteSegmentStore, id: string) {
    const row = await realGet.call(this, id);
    if (!flipped && id === raced.id) {
      flipped = true;
      await realGet.call(this, id); // read-through, then the "other admin" writes
      await SqliteSegmentStore.prototype.updateSegment.call(this, id, { enabled: false });
    }
    return row;
  } as typeof realGet;
  try {
    assert.equal((await put(raced.id, { name: "Renamed" }))?.status, 200);
  } finally {
    SqliteSegmentStore.prototype.getSegment = realGet;
  }
  const racedPayload = (await eventPayload("SEGMENT_UPDATED", raced.id)) as Record<string, unknown>;
  assert.ok(!("enabled" in racedPayload), "the event says nothing about a field it did not set");
  const after = ((await (await getList())!.json()) as Array<{ id: string; enabled: boolean }>).find((x) => x.id === raced.id);
  assert.equal(after?.enabled, false, "and the other writer's value survived, which is what the old merge would have mis-reported");
});

test("SEGMENT_CREATED reports the measure list the ROW will hold, deduped and ordered (#598)", async () => {
  // `setMeasures` writes a Set and `hydrate` reads back ordered, so the request array can name a list
  // the segment never contained. Harmless while the audit came second; a payload-accuracy regression
  // once it comes first (#612 review).
  const dupes = (await (await post({ name: "Dupes", rule: welderRule, measureIds: ["tb_surveillance", "audiogram", "audiogram"] }))!.json()) as { id: string; measureIds: string[] };
  assert.deepEqual(
    ((await eventPayload("SEGMENT_CREATED", dupes.id)) as { measureIds: string[] }).measureIds,
    dupes.measureIds,
    "the event's list is the row's list",
  );
  assert.deepEqual(dupes.measureIds, ["audiogram", "tb_surveillance"], "and not vacuous: the request sent three, deduped");
});

test("DELETE audits BEFORE the row goes — the event survives a failed delete (#598)", async () => {
  // The only externally visible difference between the two orders, and what the first cut of this case
  // did not test: it asserted the payload name came from a pre-read, which was true before the change
  // too, so it passed against the code it was written to guard (#612 review).
  const created = (await (await post({ name: "Doomed", rule: welderRule, measureIds: [] }))!.json()) as { id: string };
  const real = SqliteSegmentStore.prototype.deleteSegment;
  SqliteSegmentStore.prototype.deleteSegment = async () => { throw new Error("the delete failed"); };
  try {
    await assert.rejects(() => del(created.id) as Promise<unknown>, /the delete failed/);
  } finally {
    SqliteSegmentStore.prototype.deleteSegment = real;
  }
  assert.equal(await eventCount("SEGMENT_DELETED", created.id), 1, "the event is there although the row is not gone");
  assert.equal((await countSegments(created.id)), 1, "and the segment really did survive");
  const payload = await eventPayload("SEGMENT_DELETED", created.id);
  assert.equal((payload as { name: string }).name, "Doomed");

  // An unknown id refuses before it audits — the over-claim is for a change somebody actually asked for.
  assert.equal((await del("00000000-0000-4000-8000-000000000000"))?.status, 404);
  assert.equal(await eventCount("SEGMENT_DELETED", "00000000-0000-4000-8000-000000000000"), 0);
});

test("PUT audits BEFORE its three writes, and a row that vanishes mid-update is a 404 (#598)", async () => {
  // The PR's largest behaviour change — three writes moved and a relocated 404 — and the part that had
  // no test of either property (#612 review).
  const created = (await (await post({ name: "Before", rule: welderRule, measureIds: ["audiogram"] }))!.json()) as { id: string };
  const real = SqliteSegmentStore.prototype.updateSegment;

  // (a) the audit survives a failed update
  SqliteSegmentStore.prototype.updateSegment = async () => { throw new Error("the update failed"); };
  try {
    await assert.rejects(() => put(created.id, { name: "After" }) as Promise<unknown>, /the update failed/);
  } finally {
    SqliteSegmentStore.prototype.updateSegment = real;
  }
  assert.equal(await eventCount("SEGMENT_UPDATED", created.id), 1);
  assert.equal(((await (await getList())!.json()) as Array<{ id: string; name: string }>).find((x) => x.id === created.id)?.name, "Before",
    "the row is unchanged, so the event is an over-claim — which is the side the rule picks");

  // (b) the row VANISHING between the pre-read and the write is a clean 404, not a 500 and not a
  //     200-with-null. `updateSegment` returning null is what says so, and dropping that check was a
  //     real regression: `setMeasures` then violates the segment_measures foreign key.
  SqliteSegmentStore.prototype.updateSegment = async function vanished(this: SqliteSegmentStore, id: string) {
    await real.call(this, id, {});          // keep the timestamp behaviour honest
    await this.deleteSegment(id);           // ...and then the row goes, as a concurrent DELETE would
    return null;
  } as typeof real;
  try {
    const res = await put(created.id, { name: "Racing", measureIds: ["hazwoper"] });
    assert.equal(res?.status, 404, "a vanished row is 404 — never a 500 from the child insert");
    assert.equal(((await res!.json()) as { error: string }).error, "not_found");
  } finally {
    SqliteSegmentStore.prototype.updateSegment = real;
  }
});
