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

test("engineForEnv returns a CqlExecutionEngine and memoizes per env (unkeyed default)", async () => {
  delete process.env.WORKWELL_VSAC_API_KEY; // deterministic regardless of ambient env — inline path
  const env = await localEnv();
  const e1 = await engineForEnv(env);
  const e2 = await engineForEnv(env);
  assert.ok(e1 instanceof CqlExecutionEngine);
  assert.equal(e1, e2, "same env → same cached engine");
});

test("engineForEnv keyed path (VSAC key set) constructs a CqlExecutionEngine with the composite resolver", async () => {
  const saved = process.env.WORKWELL_VSAC_API_KEY;
  process.env.WORKWELL_VSAC_API_KEY = "test-vsac-key"; // exercises getStores + resolveValueSetResolver
  try {
    const env = await localEnv(); // fresh env → fresh cache entry, hits the keyed branch
    const engine = await engineForEnv(env); // no network: audiogram/URN routing never calls VSAC
    assert.ok(engine instanceof CqlExecutionEngine);
  } finally {
    if (saved === undefined) delete process.env.WORKWELL_VSAC_API_KEY;
    else process.env.WORKWELL_VSAC_API_KEY = saved;
  }
});
