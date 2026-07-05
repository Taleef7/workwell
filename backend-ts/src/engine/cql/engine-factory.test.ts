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

test("engineForEnv returns a CqlExecutionEngine and memoizes per env", async () => {
  const env = await localEnv();
  const e1 = await engineForEnv(env);
  const e2 = await engineForEnv(env);
  assert.ok(e1 instanceof CqlExecutionEngine);
  assert.equal(e1, e2, "same env → same cached engine");
});
