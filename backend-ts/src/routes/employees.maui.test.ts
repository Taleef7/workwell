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

const profileScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
  import { handleEmployees } from "./src/routes/employees.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-12-31T23:59:59.999Z",
  });
  const outcomes = new SqliteOutcomeStore(db);
  // An old authored-era outcome the pilot does not measure, beside two of the six it does.
  for (const [measureId, status] of [["hypertension", "COMPLIANT"], ["cms130", "OVERDUE"], ["cms122", "COMPLIANT"]]) {
    await outcomes.recordOutcome({ runId: run.id, subjectId: "pat-003", measureId, evaluationPeriod: "2026-09-01", status, evidence: {} });
  }
  const res = await handleEmployees(new Request("http://x/api/employees/pat-003/profile"), { DB: db });
  const profile = await res.json();
  console.log(JSON.stringify({ status: res.status, outcomes: profile.measureOutcomes.map((o) => ({ id: o.measureId, name: o.measureName })) }));
`;

test("Maui patient page lists only the measures the deployment runs, by name (#671)", () => {
  const output = runProfileChild("maui", profileScript, {
    WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms2,cms130,cms165,cms137",
  });
  assert.equal(output.status, 200);
  const outcomes = output.outcomes as Array<{ id: string; name: string }>;
  assert.deepEqual(outcomes.map((o) => o.id).sort(), ["cms122", "cms130"], "hypertension is not one of the six");
  assert.equal(
    outcomes.find((o) => o.id === "cms130")?.name,
    "Colorectal Cancer Screening",
    "an official-only measure is named from the catalog, not by its id",
  );
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
