import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
  import { handleOrders } from "./src/routes/orders.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);

  const olderRun = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    requestedScope: {},
    startedAt: "2026-07-17T00:00:00.000Z",
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: olderRun.id, subjectId: "pat-001", measureId: "cms122", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: olderRun.id, subjectId: "pat-001", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await runStore.finalizeRun(olderRun.id, "COMPLETED");

  const newerRun = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    requestedScope: {},
    startedAt: "2026-07-18T00:00:00.000Z",
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: newerRun.id, subjectId: "emp-001", measureId: "cms122", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: newerRun.id, subjectId: "cypress-mrn-foreign", measureId: "cms122", status: "OVERDUE", evidence: {} });
  await runStore.finalizeRun(newerRun.id, "COMPLETED");

  const res = await handleOrders(new Request("http://x/api/orders/proposals"), env);
  const body = await res.json();
  const allSubjects = [...body.proposed, ...body.suppressed].map(p => p.subjectId);
  const allMeasures = [...body.proposed, ...body.suppressed].map(p => p.measureId);

  console.log(JSON.stringify({
    allSubjects,
    allMeasures,
  }));
`;

test("scoped profile (Maui) — order proposals scope to runnable measures and Maui-resolvable subjects", () => {
  const output = runProfileChild("maui", testScript);
  const allSubjects = output.allSubjects as string[];
  const allMeasures = output.allMeasures as string[];

  assert.ok(allSubjects.includes("pat-001"), "pat-001 must receive order proposals on Maui");
  assert.ok(!allSubjects.includes("emp-001"), "emp-001 must be excluded from order proposals on Maui");
  assert.ok(!allSubjects.includes("cypress-mrn-foreign"), "foreign Cypress subject must be excluded from order proposals on Maui");
  assert.ok(!allMeasures.includes("audiogram"), "unrunnable measure audiogram must not produce order proposals on Maui");
});

test("default profile — order proposals include all active measures and subjects", () => {
  const output = runProfileChild(undefined, testScript);
  const allSubjects = output.allSubjects as string[];
  const allMeasures = output.allMeasures as string[];

  assert.ok(allSubjects.includes("pat-001"), "pat-001 present on default profile");
  assert.ok(allSubjects.includes("emp-001"), "emp-001 present on default profile");
  assert.ok(allSubjects.includes("cypress-mrn-foreign"), "cypress-mrn-foreign present on default profile");
  assert.ok(allMeasures.includes("audiogram"), "audiogram measure present on default profile");
});
