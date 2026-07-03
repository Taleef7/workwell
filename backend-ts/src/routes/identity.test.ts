/**
 * Identity route (#187 E15 PR-1): people search + DUPLICATE worklist + unified person view with a
 * merged, system-tagged compliance timeline. Seeds a couple of outcomes for the cross-system person.
 *   node --import tsx --test src/routes/identity.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { handleIdentity } from "./identity.ts";
import { getStores } from "../stores/factory.ts";

const dbPath = join(tmpdir(), `workwell-identity-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (p: string) => handleIdentity(new Request(`http://x${p}`, { method: "GET" }), env as never, "tester@workwell.dev");
const post = (p: string, body: unknown) =>
  handleIdentity(new Request(`http://x${p}`, { method: "POST", body: JSON.stringify(body) }), env as never, "cm@workwell.dev");

interface Person { personId: string; displayName: string; crossSystem: boolean; sources: { tenantId: string; externalId: string; status: string }[]; }

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const run = await runStore.createRun({
    scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {},
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  // Omar's two source records get outcomes in each system.
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "ihn-emp-001", measureId: "flu_vaccine", status: "COMPLIANT", evidence: {} });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("GET /api/identity/duplicates → only the true duplicate (moved person excluded)", async () => {
  const res = await get("/api/identity/duplicates");
  assert.equal(res?.status, 200);
  const dups = (await res!.json()) as Person[];
  assert.equal(dups.length, 1, "Sana (active in both) only; Omar is moved, not a duplicate");
  assert.ok(dups.every((p) => p.crossSystem && !p.sources.some((s) => s.status === "PRIOR")));
});

test("GET /api/identity/people?q=omar finds the cross-system person + sets X-Total-Count", async () => {
  const res = await get("/api/identity/people?q=omar");
  assert.equal(res?.status, 200);
  assert.equal(res!.headers.get("X-Total-Count"), "1");
  const people = (await res!.json()) as Person[];
  assert.equal(people.length, 1);
  assert.equal(people[0]!.crossSystem, true);
});

test("?tenant= scopes people to a system", async () => {
  const res = await get("/api/identity/people?q=omar&tenant=twh");
  const people = (await res!.json()) as Person[];
  assert.equal(people.length, 1, "Omar has a twh (PRIOR) link");
  const none = await get("/api/identity/people?q=omar&tenant=mhn");
  assert.equal(((await none!.json()) as Person[]).length, 0);
});

test("GET /api/identity/people/:id → unified, system-tagged, newest-first timeline + move", async () => {
  const omar = ((await (await get("/api/identity/people?q=omar"))!.json()) as Person[])[0]!;
  const res = await get(`/api/identity/people/${encodeURIComponent(omar.personId)}`);
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as {
    person: Person;
    timeline: { entries: { tenantId: string; measureId: string; evaluatedAt: string }[]; move: { fromTenantName: string; toTenantName: string } | null };
  };
  assert.equal(body.person.crossSystem, true);
  assert.equal(body.timeline.entries.length, 2, "both systems' outcomes unioned");
  assert.ok(body.timeline.move, "mobility annotation present");
  assert.equal(body.timeline.move!.toTenantName, "Indus Hospital Network");
});

test("unknown person → 404; unrelated path/method → null", async () => {
  assert.equal((await get("/api/identity/people/person-deadbeef"))?.status, 404);
  assert.equal(await get("/api/other"), null);
  // a POST that isn't a reconcile path → null (not handled here)
  assert.equal(await handleIdentity(new Request("http://x/api/identity/people", { method: "POST" }), env as never, "x"), null);
});

test("reconcile UNLINK splits a duplicate; CONFIRM_LINK re-merges it", async () => {
  // Sana = emp-007 (twh) ↔ ihn-emp-002 (ihn), a duplicate (both ACTIVE). Find her personId.
  const sana = ((await (await get("/api/identity/duplicates"))!.json()) as Person[])[0]!;
  assert.equal(sana.sources.length, 2);

  // UNLINK the ihn record out of Sana → she's no longer a duplicate.
  const unlink = await post(`/api/identity/people/${encodeURIComponent(sana.personId)}/reconcile`, {
    action: "UNLINK", tenantId: "ihn", externalId: "ihn-emp-002",
  });
  assert.equal(unlink?.status, 200);
  assert.equal(((await (await get("/api/identity/duplicates"))!.json()) as Person[]).length, 0, "no duplicates after unlink");

  // CONFIRM_LINK the record back to emp-007's person → duplicate restored. (Select by EXACT source id —
  // a substring `q=emp-007` would also match `ihn-emp-007`.)
  const twhSana = ((await (await get("/api/identity/people?q=Sana"))!.json()) as Person[])
    .find((p) => p.sources.some((s) => s.tenantId === "twh"))!;
  const confirm = await post(`/api/identity/people/${encodeURIComponent(twhSana.personId)}/reconcile`, {
    action: "CONFIRM_LINK", tenantId: "ihn", externalId: "ihn-emp-002",
  });
  assert.equal(confirm?.status, 200);
  assert.equal(((await (await get("/api/identity/duplicates"))!.json()) as Person[]).length, 1, "duplicate restored");
});

test("UNLINK removes the target fully from a 3-member component (never ejects the wrong record)", async () => {
  // Build a star centered on ihn-emp-050: CONFIRM it to emp-005, then CONFIRM emp-008 (which attaches
  // to ihn-emp-050) → ihn-emp-050 has TWO edges (to emp-005 and emp-008). A single-anchor UNLINK would
  // break only one edge and leave ihn-emp-050 wrongly merged with the other; breaking against ALL members
  // removes exactly the target.
  const p1 = ((await (await get("/api/identity/people?q=emp-005"))!.json()) as Person[])
    .find((p) => p.sources.some((s) => s.externalId === "emp-005"))!;
  await post(`/api/identity/people/${encodeURIComponent(p1.personId)}/reconcile`, { action: "CONFIRM_LINK", tenantId: "ihn", externalId: "ihn-emp-050" });
  const p2 = ((await (await get("/api/identity/people?q=ihn-emp-050"))!.json()) as Person[])[0]!;
  const three = await post(`/api/identity/people/${encodeURIComponent(p2.personId)}/reconcile`, { action: "CONFIRM_LINK", tenantId: "twh", externalId: "emp-008" });
  const person3 = ((await three!.json()) as { person: Person }).person;
  assert.equal(person3.sources.length, 3, "three-member component");

  // UNLINK the CENTER (ihn-emp-050) → it must be fully removed; no remaining person contains it.
  await post(`/api/identity/people/${encodeURIComponent(person3.personId)}/reconcile`, { action: "UNLINK", tenantId: "ihn", externalId: "ihn-emp-050" });
  const solo = ((await (await get("/api/identity/people?q=ihn-emp-050"))!.json()) as Person[])[0]!;
  assert.equal(solo.sources.length, 1, "the unlinked target is its own singleton");
  const emp005 = ((await (await get("/api/identity/people?q=emp-005"))!.json()) as Person[]).find((p) => p.sources.some((s) => s.externalId === "emp-005"))!;
  assert.ok(!emp005.sources.some((s) => s.externalId === "ihn-emp-050"), "the target is not wrongly left grouped with a leaf");

  // cleanup: break the remaining emp-005↔emp-008 (they separated when the center left, but be safe).
  const c = ((await (await get("/api/identity/people?q=emp-008"))!.json()) as Person[]).find((p) => p.sources.some((s) => s.externalId === "emp-008"))!;
  if (c.sources.length > 1) await post(`/api/identity/people/${encodeURIComponent(c.personId)}/reconcile`, { action: "UNLINK", tenantId: "twh", externalId: "emp-008" });
});

test("Fable H8: UNLINK the CONFIRM-anchor hub keeps the survivors grouped (no shatter)", async () => {
  // Build a star with ihn-emp-003 as the CONFIRM anchor/hub between emp-009 and emp-010 (no shared
  // nationalId — pure CONFIRMED edges). Pre-fix, UNLINK of the hub broke both its edges and the leaves,
  // never linked to each other, shattered into singletons. The survivor re-assert must keep emp-009 +
  // emp-010 as one person.
  const p1 = ((await (await get("/api/identity/people?q=emp-009"))!.json()) as Person[]).find((p) => p.sources.some((s) => s.externalId === "emp-009"))!;
  await post(`/api/identity/people/${encodeURIComponent(p1.personId)}/reconcile`, { action: "CONFIRM_LINK", tenantId: "ihn", externalId: "ihn-emp-003" });
  const p2 = ((await (await get("/api/identity/people?q=ihn-emp-003"))!.json()) as Person[])[0]!;
  const three = ((await (await post(`/api/identity/people/${encodeURIComponent(p2.personId)}/reconcile`, { action: "CONFIRM_LINK", tenantId: "twh", externalId: "emp-010" }))!.json()) as { person: Person }).person;
  assert.equal(three.sources.length, 3, "three-member component around the hub ihn-emp-003");

  await post(`/api/identity/people/${encodeURIComponent(three.personId)}/reconcile`, { action: "UNLINK", tenantId: "ihn", externalId: "ihn-emp-003" });
  const hub = ((await (await get("/api/identity/people?q=ihn-emp-003"))!.json()) as Person[])[0]!;
  assert.equal(hub.sources.length, 1, "the unlinked hub is its own singleton");
  const emp009 = ((await (await get("/api/identity/people?q=emp-009"))!.json()) as Person[]).find((p) => p.sources.some((s) => s.externalId === "emp-009"))!;
  assert.ok(emp009.sources.some((s) => s.externalId === "emp-010"), "survivors emp-009 + emp-010 remain ONE person");
  assert.ok(!emp009.sources.some((s) => s.externalId === "ihn-emp-003"), "the hub is gone from the survivors");

  // Codex P2: the survivor re-assert writes CONFIRMED links, so it must emit an audit event.
  const events = await (await getStores(env as never)).events.recentAuditEventsByType("IDENTITY_LINK_CONFIRMED", 50);
  assert.ok(
    events.some((e: { payload: Record<string, unknown> }) => (e.payload as { reason?: string }).reason === "SURVIVOR_REASSERT"),
    "the survivor re-assert emits an audited IDENTITY_LINK_CONFIRMED (reason SURVIVOR_REASSERT)",
  );

  // cleanup: split the survivors back to singletons for later tests.
  await post(`/api/identity/people/${encodeURIComponent(emp009.personId)}/reconcile`, { action: "UNLINK", tenantId: "twh", externalId: "emp-010" });
});

test("CONFIRM_LINK rejects a target that isn't a real directory record", async () => {
  const twhSana = ((await (await get("/api/identity/people?q=Sana"))!.json()) as Person[]).find((p) => p.sources.some((s) => s.tenantId === "twh"))!;
  const res = await post(`/api/identity/people/${encodeURIComponent(twhSana.personId)}/reconcile`, { action: "CONFIRM_LINK", tenantId: "twh", externalId: "does-not-exist" });
  assert.equal(res?.status, 400);
});

test("reconcile validates action + membership", async () => {
  const sana = ((await (await get("/api/identity/duplicates"))!.json()) as Person[])[0]!;
  const base = `/api/identity/people/${encodeURIComponent(sana.personId)}/reconcile`;
  assert.equal((await post(base, { action: "NOPE", tenantId: "ihn", externalId: "ihn-emp-002" }))?.status, 400);
  assert.equal((await post(base, { action: "UNLINK" }))?.status, 400, "missing tenantId/externalId");
  assert.equal((await post(base, { action: "UNLINK", tenantId: "ihn", externalId: "ihn-emp-050" }))?.status, 400, "not a member");
  assert.equal((await post("/api/identity/people/person-nope/reconcile", { action: "CONFIRM_LINK", tenantId: "twh", externalId: "emp-005" }))?.status, 404);
});
