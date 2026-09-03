import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { handleEmployees } from "./src/routes/employees.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };

  const niloRes = await handleEmployees(new Request("http://x/api/employees/search?q=nilo"), env);
  const nilo = await niloRes.json();

  const omarRes = await handleEmployees(new Request("http://x/api/employees/search?q=omar"), env);
  const omar = await omarRes.json();

  console.log(JSON.stringify({ nilo, omar }));
`;

test("scoped profile (Maui) — employees search returns Maui patients and excludes TWH employees", () => {
  const output = runProfileChild("maui", testScript);
  const nilo = output.nilo as Array<{ externalId: string; name: string; site: string }>;
  const omar = output.omar as Array<{ externalId: string; name: string }>;

  assert.equal(nilo.length, 1, "Maui search for 'nilo' must return exactly 1 result");
  assert.equal(nilo[0]?.externalId, "pat-048", "returned patient must be pat-048");
  assert.equal(nilo[0]?.name, "Nilo Gray", "returned patient name must be Nilo Gray");
  assert.deepEqual(omar, [], "TWH-only name must return empty array on Maui profile");
});

test("default profile — employees search returns both Maui and TWH employees", () => {
  const output = runProfileChild(undefined, testScript);
  const nilo = output.nilo as Array<{ externalId: string; name: string }>;
  const omar = output.omar as Array<{ externalId: string; name: string }>;

  assert.equal(nilo.length, 1, "default profile search for 'nilo' returns pat-048");
  assert.equal(nilo[0]?.externalId, "pat-048");
  assert.ok(omar.length > 0, "TWH employee returns results on default profile");
  assert.ok(omar.some((e) => e.externalId === "emp-006"), "returns Omar Siddiq (emp-006)");
});
