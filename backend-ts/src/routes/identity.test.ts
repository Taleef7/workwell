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
import { personIdFor } from "../identity/identity-model.ts";
import { handleIdentity } from "./identity.ts";

const dbPath = join(tmpdir(), `workwell-identity-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (p: string) => handleIdentity(new Request(`http://x${p}`, { method: "GET" }), env as never);

interface Person { personId: string; displayName: string; crossSystem: boolean; sources: { tenantId: string; status: string }[]; }

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

test("GET /api/identity/duplicates → the 2 cross-system people", async () => {
  const res = await get("/api/identity/duplicates");
  assert.equal(res?.status, 200);
  const dups = (await res!.json()) as Person[];
  assert.equal(dups.length, 2);
  assert.ok(dups.every((p) => p.crossSystem));
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
  const res = await get(`/api/identity/people/${personIdFor("nid:nid-100-omar")}`);
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
  assert.equal(await handleIdentity(new Request("http://x/api/identity/people", { method: "POST" }), env as never), null);
});
