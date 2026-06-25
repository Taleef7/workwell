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
  // bad override mode
  assert.equal((await post({ name: "x", rule: welderRule, measureIds: ["audiogram"], overrides: [{ externalId: "emp-006", mode: "BOGUS" }] }))?.status, 400);
});

test("malformed PUT (bad rule) → 400", async () => {
  const created = (await post({ name: "PutValidate", rule: welderRule, measureIds: ["audiogram"] }).then((r) => r!.json())) as { id: string };
  assert.equal((await put(created.id, { rule: { match: "MAYBE", conditions: [] } }))?.status, 400);
});

test("non-segment path → handler returns null", async () => {
  assert.equal(await handleSegments(new Request("http://x/api/cases", { method: "GET" }), env as never, actor), null);
});
