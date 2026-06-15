/**
 * Route test for value-set governance (#108) — the Studio Value Sets tab + governance panel
 * + the Admin terminology mappings, over the seeded catalog.
 *   node --import tsx --test src/routes/value-set-governance.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { handleMeasures } from "./measures.ts";
import { handleAdmin } from "./admin.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";

const dbPath = join(tmpdir(), `workwell-vsg-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };

const get = (path: string) => handleMeasures(new Request(`http://x${path}`, { method: "GET" }), env as never, "author@workwell.dev");
const post = (path: string, body?: unknown) =>
  handleMeasures(new Request(`http://x${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }), env as never, "author@workwell.dev");
const del = (path: string) => handleMeasures(new Request(`http://x${path}`, { method: "DELETE" }), env as never, "author@workwell.dev");
const adminGet = (path: string) => handleAdmin(new Request(`http://x${path}`, { method: "GET" }), env as never, "admin@workwell.dev");
const adminPost = (path: string, body: unknown) =>
  handleAdmin(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), env as never, "admin@workwell.dev");

before(async () => {
  env = { DB: await createSqliteD1(dbPath) };
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

interface ValueSetRef {
  id: string;
  oid: string;
  name: string;
  version: string;
  resolvabilityStatus: string;
  resolvabilityLabel: string;
  codeCount: number;
}

test("GET /api/value-sets lists the demo catalog (UNRESOLVED/0 like Java listValueSets)", async () => {
  const list = (await get("/api/value-sets").then((r) => r!.json())) as ValueSetRef[];
  assert.ok(list.length >= 22, "all demo value sets seeded");
  // The catalog list intentionally reports UNRESOLVED/0 (no per-set expansion at list time).
  assert.ok(list.every((v) => v.resolvabilityStatus === "UNRESOLVED" && v.codeCount === 0));
  // Ordered by name ASC (SQL ORDER BY name ASC — binary/byte order).
  const names = list.map((v) => v.name);
  for (let i = 1; i < names.length; i++) assert.ok(names[i - 1]! <= names[i]!, `sorted: ${names[i - 1]} <= ${names[i]}`);
  assert.ok(names.includes("Audiogram Procedures"));
});

test("GET /api/measures/versions/:vid/value-sets returns audiogram's 3 resolved sets", async () => {
  // The audiogram version id is the floor <slug>-<version> form.
  const detail = (await get("/api/measures/audiogram").then((r) => r!.json())) as { version: string; valueSets: ValueSetRef[] };
  const versionId = `audiogram-${detail.version}`;
  const linked = (await get(`/api/measures/versions/${versionId}/value-sets`).then((r) => r!.json())) as ValueSetRef[];
  assert.equal(linked.length, 3);
  assert.ok(linked.some((v) => v.name === "Audiogram Procedures"));
  // Demo sets (urn:workwell:vs:*) are RESOLVED with their codes counted.
  const procedures = linked.find((v) => v.name === "Audiogram Procedures")!;
  assert.equal(procedures.resolvabilityStatus, "RESOLVED");
  assert.equal(procedures.codeCount, 5);
});

test("resolve-check on audiogram: all resolved, no blockers", async () => {
  const res = (await post("/api/measures/audiogram/value-sets/resolve-check").then((r) => r!.json())) as {
    measureId: string;
    allResolved: boolean;
    blockers: string[];
    valueSets: Array<{ name: string; blocker: boolean }>;
  };
  assert.equal(res.measureId, "audiogram");
  assert.equal(res.allResolved, true);
  assert.deepEqual(res.blockers, []);
  assert.equal(res.valueSets.length, 3);
});

test("resolve-check on an unknown measure → 404", async () => {
  const res = await post("/api/measures/nope/value-sets/resolve-check");
  assert.equal(res?.status, 404);
});

// Regression: seeded value-set names must match the CQL `valueset "..."` declarations, or
// resolveCheck reports them as unattached-reference blockers (the wellness names were aligned).
for (const measureId of ["cholesterol_ldl", "diabetes_hba1c", "obesity_bmi", "hypertension", "hazwoper", "tb_surveillance", "flu_vaccine"]) {
  test(`resolve-check on ${measureId}: all resolved, no unattached-reference blockers`, async () => {
    const res = (await post(`/api/measures/${measureId}/value-sets/resolve-check`).then((r) => r!.json())) as {
      allResolved: boolean;
      blockers: string[];
    };
    assert.equal(res.allResolved, true, `blockers: ${JSON.stringify(res.blockers)}`);
    assert.ok(!res.blockers.some((b) => b.includes("not attached")), `no unattached refs: ${JSON.stringify(res.blockers)}`);
  });
}

test("create → attach → detach a value set drives listByVersion", async () => {
  const detail = (await get("/api/measures/tb_surveillance").then((r) => r!.json())) as { version: string };
  const versionId = `tb_surveillance-${detail.version}`;

  const created = (await post("/api/value-sets", { oid: "urn:test:vs:extra", name: "Extra TB Set", version: "v1" }).then((r) => r!.json())) as { id: string };
  assert.ok(created.id, "new value set id");

  const before = ((await get(`/api/measures/versions/${versionId}/value-sets`).then((r) => r!.json())) as ValueSetRef[]).length;
  const attach = await post(`/api/measures/tb_surveillance/value-sets/${created.id}`);
  assert.equal(attach?.status, 200);
  assert.equal((await attach!.json() as { status: string }).status, "linked");

  const afterAttach = (await get(`/api/measures/versions/${versionId}/value-sets`).then((r) => r!.json())) as ValueSetRef[];
  assert.equal(afterAttach.length, before + 1);
  assert.ok(afterAttach.some((v) => v.id === created.id));

  const detach = await del(`/api/measures/tb_surveillance/value-sets/${created.id}`);
  assert.equal(detach?.status, 200);
  assert.equal((await detach!.json() as { status: string }).status, "unlinked");
  const afterDetach = (await get(`/api/measures/versions/${versionId}/value-sets`).then((r) => r!.json())) as ValueSetRef[];
  assert.equal(afterDetach.length, before);
});

test("attach/detach audits carry the authenticated actor (not 'system')", async () => {
  const created = (await post("/api/value-sets", { oid: "urn:test:vs:actor", name: "Actor Set", version: "v1" }).then((r) => r!.json())) as { id: string };
  await post(`/api/measures/hazwoper/value-sets/${created.id}`); // author@workwell.dev
  await del(`/api/measures/hazwoper/value-sets/${created.id}`);
  const audits = await new SqliteCaseEventStore(env.DB as never).listAuditEvents();
  const linked = audits.find((a) => a.eventType === "MEASURE_VALUE_SET_LINKED" && (a.payload as { valueSetId?: string }).valueSetId === created.id);
  const unlinked = audits.find((a) => a.eventType === "MEASURE_VALUE_SET_UNLINKED" && (a.payload as { valueSetId?: string }).valueSetId === created.id);
  assert.equal(linked?.actor, "author@workwell.dev");
  assert.equal(unlinked?.actor, "author@workwell.dev");
});

test("POST /api/value-sets with missing oid/name → 400", async () => {
  const res = await post("/api/value-sets", { name: "" });
  assert.equal(res?.status, 400);
});

test("GET /api/value-sets/:id/detail returns codes + systems; unknown → 404", async () => {
  const detail = (await get("/api/value-sets/a0000001-0000-0000-0000-000000000001/detail").then((r) => r!.json())) as {
    name: string;
    codeCount: number;
    codes: Array<{ code: string }>;
    codeSystems: string[];
  };
  assert.equal(detail.name, "Audiogram Procedures");
  assert.equal(detail.codeCount, 5);
  assert.ok(detail.codes.some((c) => c.code === "92557"));
  assert.ok(detail.codeSystems.includes("http://www.ama-assn.org/go/cpt"));
  assert.equal((await get("/api/value-sets/missing/detail"))?.status, 404);
});

test("GET /api/value-sets/:id/diff: added/removed codes + affected measures + warning", async () => {
  // TB Screening Procedures (4 codes) vs Audiogram Procedures (5 codes).
  const from = "a0000001-0000-0000-0000-000000000002"; // TB
  const to = "a0000001-0000-0000-0000-000000000001"; // Audiogram
  const res = (await get(`/api/value-sets/${from}/diff?toId=${to}`).then((r) => r!.json())) as {
    addedCodes: Array<{ code: string }>;
    removedCodes: Array<{ code: string }>;
    affectedMeasures: Array<{ measureName: string }>;
    warnings: string[];
  };
  assert.ok(res.addedCodes.length > 0);
  assert.ok(res.removedCodes.length > 0);
  // Both value sets are attached to seeded measures (TB Surveillance + Audiogram).
  assert.ok(res.affectedMeasures.some((m) => m.measureName === "Annual Audiogram Completed"));
  assert.ok(res.warnings.some((w) => w.includes("removed")));
});

test("diff without toId → 400", async () => {
  assert.equal((await get("/api/value-sets/a0000001-0000-0000-0000-000000000001/diff"))?.status, 400);
});

test("activation-readiness folds the value-set resolve-check (valueSetCount + allResolved)", async () => {
  const r = (await get("/api/measures/audiogram/activation-readiness").then((res) => res!.json())) as {
    ready: boolean;
    valueSetCount: number;
    activationBlockers: string[];
  };
  assert.equal(r.valueSetCount, 3, "audiogram's 3 attached value sets counted");
  // audiogram has demo fixtures (V015) + resolved value sets → no value-set blockers.
  assert.ok(!r.activationBlockers.some((b) => b.toLowerCase().includes("value set")));
});

test("traceability now carries the attached value sets (gap no longer fires for audiogram)", async () => {
  const t = (await get("/api/measures/audiogram/traceability").then((r) => r!.json())) as {
    rows: Array<{ valueSets: Array<{ name: string }> }>;
    gaps: Array<{ message: string }>;
  };
  assert.ok(t.rows[0]!.valueSets.length >= 1, "rows carry attached value sets");
  assert.ok(!t.gaps.some((g) => g.message.toLowerCase().includes("no value sets")), "value-set gap does not fire");
});

test("admin terminology-mappings: lists demo seeds then create appends + audits", async () => {
  const before = (await adminGet("/api/admin/terminology-mappings").then((r) => r!.json())) as Array<{ localCode: string; mappingStatus: string }>;
  assert.ok(before.length >= 5, "5 demo terminology rows seeded");
  // status-ordered (APPROVED before PROPOSED/REVIEWED alphabetically).
  assert.deepEqual(before.map((m) => m.mappingStatus), [...before.map((m) => m.mappingStatus)].sort());

  const created = await adminPost("/api/admin/terminology-mappings", {
    localCode: "LOCAL-NEW",
    localSystem: "urn:workwell:demo",
    standardCode: "99999",
    standardSystem: "http://www.ama-assn.org/go/cpt",
    mappingStatus: "PROPOSED",
  });
  assert.equal(created?.status, 201);
  const after = (await adminGet("/api/admin/terminology-mappings").then((r) => r!.json())) as Array<{ localCode: string }>;
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((m) => m.localCode === "LOCAL-NEW"));
});

test("admin terminology create with missing required fields → 400", async () => {
  const res = await adminPost("/api/admin/terminology-mappings", { localCode: "X" });
  assert.equal(res?.status, 400);
});
