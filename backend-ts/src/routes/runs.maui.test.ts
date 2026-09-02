import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { handleRuns } from "./src/routes/runs.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const run = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    status: "COMPLETED",
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:01:00.000Z",
    requestedScope: {},
    measurementPeriodStart: "2026-07-17T00:00:00.000Z",
    measurementPeriodEnd: "2026-07-17T00:00:00.000Z",
  });
  await outcomes.recordOutcomes([
    { runId: run.id, subjectId: "pat-001", measureId: "cms122", status: "COMPLIANT", evidence: {} },
    { runId: run.id, subjectId: "emp-001", measureId: "cms122", status: "OVERDUE", evidence: {} },
    { runId: run.id, subjectId: "pat-002", measureId: "cms122", status: "COMPLIANT", evidence: {} },
  ]);

  const page = async (offset) => {
    const response = await handleRuns(
      new Request("http://x/api/runs/" + run.id + "/outcomes?limit=1&offset=" + offset),
      env,
    );
    return {
      total: response.headers.get("X-Total-Count"),
      ids: (await response.json()).map(row => row.employeeExternalId),
    };
  };
  console.log(JSON.stringify({ first: await page(0), second: await page(1), third: await page(2) }));
`;

test("scoped profile (Maui) — outcomes paging counts and slices visible rows", () => {
  const output = runProfileChild("maui", testScript);
  const first = output.first as { total: string; ids: string[] };
  const second = output.second as { total: string; ids: string[] };
  const third = output.third as { total: string; ids: string[] };

  assert.equal(first.total, "2", "Maui total count must include only visible rows");
  assert.equal(second.total, "2", "Maui total count must stay stable across pages");
  assert.equal(third.total, "2", "Maui total count must stay stable on the empty page");
  assert.equal(first.ids.length, 1);
  assert.equal(second.ids.length, 1);
  assert.deepEqual([...first.ids, ...second.ids].sort(), ["pat-001", "pat-002"]);
  assert.deepEqual(third.ids, []);
});

test("default profile — outcomes paging retains unresolvable subjects in rows and totals", () => {
  const output = runProfileChild(undefined, testScript);
  const first = output.first as { total: string; ids: string[] };
  const second = output.second as { total: string; ids: string[] };
  const third = output.third as { total: string; ids: string[] };

  assert.equal(first.total, "3", "default total count must include the unresolvable subject");
  assert.equal(second.total, "3");
  assert.equal(third.total, "3");
  assert.deepEqual([...first.ids, ...second.ids, ...third.ids].sort(), ["emp-001", "pat-001", "pat-002"]);
});
