/**
 * Store-factory seam tests (#109): failed-init eviction + active-backend resolution.
 * node --import tsx --test src/stores/factory.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { getStores, getBackend } from "./factory.ts";

const newDbPath = () => join(tmpdir(), `workwell-factory-${crypto.randomUUID()}.sqlite`);

test("getStores evicts a failed init so the next request retries (no poisoned cache)", async () => {
  const dbPath = newDbPath();
  const real = await createSqliteD1(dbPath);
  let failNext = true;
  let execCalls = 0;
  // Proxy the real D1: the first exec() (the startup DDL) throws like a transient Neon/D1 error;
  // every later call delegates to the real driver so a retry can actually build.
  const db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return async (sql: string) => {
          execCalls++;
          if (failNext) {
            failNext = false;
            throw new Error("transient DDL failure");
          }
          return (target as { exec(s: string): Promise<unknown> }).exec(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = { DB: db };

  await assert.rejects(getStores(env), /transient DDL failure/, "first init surfaces the failure");
  const stores = await getStores(env); // must rebuild, not replay the cached rejection
  assert.ok(stores.runs, "second call resolves a fresh store bundle after eviction");
  assert.ok(execCalls >= 2, "build re-ran after the failed attempt was evicted from the cache");

  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("getBackend resolves the SQLite floor when no DATABASE_URL is set", async () => {
  const dbPath = newDbPath();
  const db = await createSqliteD1(dbPath);
  const env = { DB: db };
  const backend = await getBackend(env);
  assert.equal(backend.kind, "sqlite");
  assert.equal(backend.kind === "sqlite" && backend.db, db);
  // A blank DATABASE_URL is treated as unset (the floor stays the default).
  const blank = await getBackend({ DB: db, DATABASE_URL: "  " });
  assert.equal(blank.kind, "sqlite");

  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});
