import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { engineForEnv } from "./engine-factory.ts";
import { getStores } from "../../stores/factory.ts";

// Build the same local env getStores uses (SQLite floor, in-memory).
async function localEnv() {
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const DB = await createSqliteD1(":memory:");
  return { DB };
}

async function seedOneValueSet(env: { DB: unknown }) {
  const stores = await getStores(env as Parameters<typeof getStores>[0]);
  await stores.valueSets.seedValueSet({
    id: "vs-x",
    oid: "urn:workwell:vs:x",
    name: "X",
    version: "1",
    codes: [{ code: "c", display: "c", system: "s" }],
  });
}

test("engineForEnv unkeyed default returns the shared stateless inline engine (no resolver)", async () => {
  delete process.env.WORKWELL_VSAC_API_KEY; // deterministic regardless of ambient env — inline path
  const env = await localEnv();
  const other = await localEnv();
  const e1 = await engineForEnv(env);
  const e2 = await engineForEnv(env);
  const e3 = await engineForEnv(other);
  assert.ok(e1 instanceof CqlExecutionEngine);
  assert.equal(e1, e2, "unkeyed → the same shared inline engine");
  assert.equal(e1, e3, "unkeyed is env-independent (stateless, no resolver) → same shared instance");
});

test("engineForEnv reads the VSAC key from the worker env, not only process.env (Codex P2)", async () => {
  const saved = process.env.WORKWELL_VSAC_API_KEY;
  delete process.env.WORKWELL_VSAC_API_KEY; // key is ONLY on the env object, not process.env
  try {
    const env = await localEnv();
    delete process.env.WORKWELL_VSAC_API_KEY;
    const inline = await engineForEnv(env); // no env key → inline (shared)
    await seedOneValueSet(env); // value sets present so the seed guard doesn't force inline
    const keyed = await engineForEnv({ ...env, WORKWELL_VSAC_API_KEY: "env-supplied-key" });
    assert.ok(keyed instanceof CqlExecutionEngine);
    assert.notEqual(keyed, inline, "an env-supplied key must reach the keyed (resolver) branch");
  } finally {
    if (saved === undefined) delete process.env.WORKWELL_VSAC_API_KEY;
    else process.env.WORKWELL_VSAC_API_KEY = saved;
  }
});

test("engineForEnv keyed + UNSEEDED store falls back to the shared inline engine (seed guard — Codex P2)", async () => {
  const saved = process.env.WORKWELL_VSAC_API_KEY;
  try {
    const env = await localEnv();
    delete process.env.WORKWELL_VSAC_API_KEY;
    const inline = await engineForEnv(env); // unkeyed → shared inline engine
    process.env.WORKWELL_VSAC_API_KEY = "test-vsac-key";
    const keyedEmpty = await engineForEnv(env); // keyed but the store has no value sets yet
    assert.equal(keyedEmpty, inline, "unseeded store → the inline engine even when keyed (never expands to [])");
  } finally {
    if (saved === undefined) delete process.env.WORKWELL_VSAC_API_KEY;
    else process.env.WORKWELL_VSAC_API_KEY = saved;
  }
});

test("engineForEnv keyed + SEEDED store builds a FRESH engine per call (no frozen snapshot — Codex P1)", async () => {
  const saved = process.env.WORKWELL_VSAC_API_KEY;
  process.env.WORKWELL_VSAC_API_KEY = "test-vsac-key"; // exercises getStores + resolveValueSetResolver
  try {
    const env = await localEnv();
    await seedOneValueSet(env); // store non-empty → the resolver engine path (no network: URN routing)
    const e1 = await engineForEnv(env);
    const e2 = await engineForEnv(env);
    assert.ok(e1 instanceof CqlExecutionEngine);
    assert.notEqual(e1, e2, "keyed + seeded → a fresh engine (and fresh resolver) per call");
  } finally {
    if (saved === undefined) delete process.env.WORKWELL_VSAC_API_KEY;
    else process.env.WORKWELL_VSAC_API_KEY = saved;
  }
});
