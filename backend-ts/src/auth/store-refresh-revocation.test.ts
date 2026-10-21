/**
 * #688: a login survives a restart. Two auth handlers built over the SAME database are two processes —
 * the one that served the login, and the one a deploy replaced it with. The in-memory KV each process
 * gets is empty, as it is after a real restart; only the database carries over.
 *   node --import tsx --test src/auth/store-refresh-revocation.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteAuthFamilyStore } from "../stores/sqlite/auth-family-store-sqlite.ts";
import { createAuthHandler, type AuthAuditEvent } from "../routes/auth.ts";
import { authAudit, refreshRevocation, type Env } from "../worker.ts";

const SECRET = "store-refresh-revocation-test-secret";
const dbPaths: string[] = [];
after(() => {
  for (const p of dbPaths) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort: Windows keeps the file locked while the handle is open
    }
  }
});

async function freshDb(): Promise<Env["DB"]> {
  const path = join(tmpdir(), `workwell-auth-families-${crypto.randomUUID()}.sqlite`);
  dbPaths.push(path);
  const db = await createSqliteD1(path);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return db;
}

/** A process's own in-memory KV — empty at start, like the MIE stacks' CACHE after a restart. */
function emptyKv(): Env["CACHE"] {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
  } as unknown as Env["CACHE"];
}

/** One "process": an auth handler whose revocation and audit are chosen exactly as the worker chooses them. */
function processOver(db: Env["DB"], audit: ((e: AuthAuditEvent) => Promise<void>) | undefined = authAudit({ DB: db })) {
  const h = createAuthHandler({ secret: SECRET, revocation: refreshRevocation({ DB: db, CACHE: emptyKv() }), audit });
  return (path: string, cookie?: string) =>
    h(
      new Request(`http://x${path}`, {
        method: "POST",
        headers: cookie ? { cookie: `refresh_token=${cookie}` } : {},
        body: path.endsWith("login") ? JSON.stringify({ email: "cm@workwell.dev", password: "Workwell123!" }) : undefined,
      }),
    );
}

const cookieOf = (res: Response | null): string => res!.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;

test("a login made before a restart still refreshes after it (#688)", async () => {
  const db = await freshDb();
  const before = processOver(db);
  const token = cookieOf(await before("/api/auth/login"));

  const afterRestart = processOver(db);
  const refreshed = await afterRestart("/api/auth/refresh", token);
  assert.equal(refreshed?.status, 200, "the new process finds the family the old one recorded");
});

test("rotation and logout still revoke across a restart (#688)", async () => {
  const db = await freshDb();
  const first = processOver(db);
  const token1 = cookieOf(await first("/api/auth/login"));
  const token2 = cookieOf(await first("/api/auth/refresh", token1));

  const second = processOver(db);
  assert.equal((await second("/api/auth/refresh", token1))?.status, 401, "a rotated-away token replayed after a restart is still reuse");
  assert.equal((await second("/api/auth/refresh", token2))?.status, 401, "and reuse still revokes the whole family");

  const token3 = cookieOf(await second("/api/auth/login"));
  assert.equal((await second("/api/auth/logout", token3))?.status, 204);
  assert.equal((await processOver(db)("/api/auth/refresh", token3))?.status, 401, "a logout is still a logout after a restart");
});

test("the family store forgets a family at its expiry and drops lapsed rows on the next rotation (#688)", async () => {
  const db = await freshDb();
  const store = new SqliteAuthFamilyStore(db);
  await store.rotate("fam-a", "jti-1", "2026-09-24T12:00:00.000Z", "2026-09-24T04:00:00.000Z");
  assert.equal(await store.currentJti("fam-a", "2026-09-24T11:59:59.000Z"), "jti-1");
  assert.equal(await store.currentJti("fam-a", "2026-09-24T12:00:00.000Z"), null, "lapsed at its expiry");

  await store.rotate("fam-a", "jti-2", "2026-09-24T20:00:00.000Z", "2026-09-24T12:00:00.000Z");
  assert.equal(await store.currentJti("fam-a", "2026-09-24T12:00:01.000Z"), "jti-2", "a rotation replaces the jti and extends the family");

  await store.rotate("fam-b", "jti-b", "2026-09-25T04:00:00.000Z", "2026-09-24T21:00:00.000Z");
  const { results } = await db.prepare("SELECT family FROM auth_refresh_families ORDER BY family").all<{ family: string }>();
  assert.deepEqual((results ?? []).map((r) => r.family), ["fam-b"], "fam-a lapsed at 20:00 and was removed by the 21:00 rotation");

  await store.revoke("fam-b");
  assert.equal(await store.currentJti("fam-b", "2026-09-24T21:00:01.000Z"), null);
});

test("consume deletes a family only for its current, unexpired jti, and only once (#704)", async () => {
  const store = new SqliteAuthFamilyStore(await freshDb());
  await store.rotate("code-1", "jti-1", "2026-10-20T12:01:00.000Z", "2026-10-20T12:00:00.000Z");
  assert.equal(await store.consume("code-1", "jti-other", "2026-10-20T12:00:30.000Z"), false, "another jti does not consume it");
  assert.equal(await store.consume("code-1", "jti-1", "2026-10-20T12:01:00.000Z"), false, "nor does the right jti at its expiry");
  assert.equal(await store.consume("code-1", "jti-1", "2026-10-20T12:00:30.000Z"), true);
  assert.equal(await store.consume("code-1", "jti-1", "2026-10-20T12:00:31.000Z"), false, "a second redemption finds nothing");
  await store.rotate("code-2", "j", "2026-10-20T13:00:00.000Z", "2026-10-20T12:00:00.000Z");
  const both = await Promise.all([1, 2].map(() => store.consume("code-2", "j", "2026-10-20T12:30:00.000Z")));
  assert.equal(both.filter(Boolean).length, 1, "of two concurrent redemptions exactly one wins");
});

test("listByPrefix returns the live families with that prefix only, with their expiry (#704)", async () => {
  const store = new SqliteAuthFamilyStore(await freshDb());
  const now = "2026-10-20T12:00:00.000Z";
  await store.rotate("mcp-pat:a", "j", "2026-11-01T00:00:00.000Z", now);
  await store.rotate("mcp-pat:b", "j", "2026-10-20T11:00:00.000Z", "2026-10-20T10:00:00.000Z"); // lapsed by `now`
  await store.rotate("mcp-patX", "j", "2026-11-01T00:00:00.000Z", now); // not the prefix (no colon)
  await store.rotate("login-family", "j", "2026-11-01T00:00:00.000Z", now);
  await store.rotate("mcp_pat:c", "j", "2026-11-01T00:00:00.000Z", now); // `_` is not a wildcard here
  assert.deepEqual(await store.listByPrefix("mcp-pat:", now), [{ family: "mcp-pat:a", jti: "j", expiresAt: "2026-11-01T00:00:00.000Z" }]);
});

test("rotateIf replaces the jti only from the current one, so one of two concurrent rotations wins (#704)", async () => {
  const store = new SqliteAuthFamilyStore(await freshDb());
  const now = "2026-10-20T12:00:00.000Z";
  await store.rotate("grant", "r1", "2026-11-19T12:00:00.000Z", now);
  const raced = await Promise.all([
    store.rotateIf("grant", "r1", "r2a", "2026-11-19T12:00:00.000Z", now),
    store.rotateIf("grant", "r1", "r2b", "2026-11-19T12:00:00.000Z", now),
  ]);
  assert.deepEqual(raced.filter(Boolean).length, 1);
  assert.ok(["r2a", "r2b"].includes((await store.currentJti("grant", now))!));
  assert.equal(await store.rotateIf("grant", "r1", "r3", "2026-11-19T12:00:00.000Z", now), false, "a stale jti never rotates");
  assert.equal(await store.rotateIf("gone", "r1", "r3", "2026-11-19T12:00:00.000Z", now), false, "nor does a missing family");
  assert.equal(await store.rotateIf("grant", (await store.currentJti("grant", now))!, "r4", "2026-11-19T12:00:00.000Z", "2026-11-19T12:00:00.000Z"), false, "nor a lapsed one");
});

const authEvents = async (db: Env["DB"]) =>
  (
    (
      await db
        .prepare("SELECT event_type AS type, actor, entity_id AS family FROM audit_events WHERE entity_type = 'auth' ORDER BY id")
        .all<{ type: string; actor: string; family: string }>()
    ).results ?? []
  ).map((r) => ({ type: r.type, actor: r.actor, family: r.family }));
const familyRows = async (db: Env["DB"]) =>
  ((await db.prepare("SELECT family FROM auth_refresh_families").all<{ family: string }>()).results ?? []).map((r) => r.family);

test("login, logout and a replayed token are audited; a rotation inside a family is not (#688)", async () => {
  const db = await freshDb();
  const p = processOver(db);
  const token1 = cookieOf(await p("/api/auth/login"));
  const [family] = await familyRows(db);
  const token2 = cookieOf(await p("/api/auth/refresh", token1));
  cookieOf(await p("/api/auth/refresh", token2));
  assert.deepEqual(await authEvents(db), [{ type: "AUTH_LOGIN", actor: "cm@workwell.dev", family }], "one login, two rotations: one event");

  assert.equal((await p("/api/auth/refresh", token1))?.status, 401);
  const token3 = cookieOf(await p("/api/auth/login"));
  const family3 = (await familyRows(db))[0];
  assert.equal((await p("/api/auth/logout", token3))?.status, 204);
  assert.deepEqual(
    (await authEvents(db)).map((e) => [e.type, e.family]),
    [["AUTH_LOGIN", family], ["AUTH_REFRESH_REUSE_DETECTED", family], ["AUTH_LOGIN", family3], ["AUTH_LOGOUT", family3]],
  );
});

test("audit-first: a login whose event cannot be written records no family; a logout still revokes (#688)", async () => {
  const db = await freshDb();
  const failing = async () => {
    throw new Error("audit store down");
  };
  const token = cookieOf(await processOver(db, failing)("/api/auth/login"));
  assert.deepEqual(await familyRows(db), [], "no family the ledger does not know about");
  assert.equal((await processOver(db)("/api/auth/refresh", token))?.status, 200, "the login still works, untracked (the store-outage degradation)");

  const tracked = cookieOf(await processOver(db)("/api/auth/login"));
  assert.equal((await familyRows(db)).length, 2, "the untracked token was upgraded into a family on refresh, and the new login opened one");
  assert.equal((await processOver(db, failing)("/api/auth/logout", tracked))?.status, 204);
  assert.equal((await processOver(db)("/api/auth/refresh", tracked))?.status, 401, "a logout ends the session even when its event could not be written");
});
