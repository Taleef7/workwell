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
import { createAuthHandler } from "../routes/auth.ts";
import { refreshRevocation, type Env } from "../worker.ts";

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

/** One "process": an auth handler whose revocation is chosen exactly as the worker chooses it. */
function processOver(db: Env["DB"]) {
  const h = createAuthHandler({ secret: SECRET, revocation: refreshRevocation({ DB: db, CACHE: emptyKv() }) });
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
