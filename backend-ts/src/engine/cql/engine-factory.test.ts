import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { engineForEnv } from "./engine-factory.ts";

// Build the same local env getStores uses (SQLite floor, in-memory).
async function localEnv() {
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const DB = await createSqliteD1(":memory:");
  return { DB };
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

test("engineForEnv keyed path builds a FRESH engine per call (no frozen store snapshot — Codex P1)", async () => {
  const saved = process.env.WORKWELL_VSAC_API_KEY;
  process.env.WORKWELL_VSAC_API_KEY = "test-vsac-key"; // exercises getStores + resolveValueSetResolver
  try {
    const env = await localEnv(); // hits the keyed branch; no network — audiogram/URN routing never calls VSAC
    const e1 = await engineForEnv(env);
    const e2 = await engineForEnv(env);
    assert.ok(e1 instanceof CqlExecutionEngine);
    assert.notEqual(e1, e2, "keyed → a fresh engine (and fresh resolver) per call, so store edits/seeds are always visible");
  } finally {
    if (saved === undefined) delete process.env.WORKWELL_VSAC_API_KEY;
    else process.env.WORKWELL_VSAC_API_KEY = saved;
  }
});
