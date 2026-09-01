import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
  import { SqliteCaseStore } from "./src/stores/sqlite/case-store-sqlite.ts";
  import { buildHierarchyRollup } from "./src/program/hierarchy-rollup.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const runStore = new SqliteRunStore(db);
  const outcomeStore = new SqliteOutcomeStore(db);
  const caseStore = new SqliteCaseStore(db);

  const olderRun = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    status: "COMPLETED",
    requestedScope: {},
    startedAt: "2026-07-17T00:00:00.000Z",
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  await outcomeStore.recordOutcome({ runId: olderRun.id, subjectId: "pat-001", measureId: "cms122", status: "COMPLIANT", evidence: {} });
  await outcomeStore.recordOutcome({ runId: olderRun.id, subjectId: "cypress-mrn-foreign", measureId: "cms125", status: "OVERDUE", evidence: {} });
  await runStore.finalizeRun(olderRun.id, "COMPLETED");

  const newerRun = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    status: "COMPLETED",
    requestedScope: {},
    startedAt: "2026-07-18T00:00:00.000Z",
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  await outcomeStore.recordOutcome({ runId: newerRun.id, subjectId: "emp-001", measureId: "cms122", status: "OVERDUE", evidence: {} });
  await outcomeStore.recordOutcome({ runId: newerRun.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await caseStore.upsertFromOutcome({ runId: newerRun.id, subjectId: "pat-001", measureId: "audiogram", evaluationPeriod: "2026-07-18", outcomeStatus: "OVERDUE" });
  await runStore.finalizeRun(newerRun.id, "COMPLETED");

  const deps = { outcomeStore, caseStore, runStore, webChartEnv: {} };
  const root = await buildHierarchyRollup(deps, {});
  const audiogramRoot = await buildHierarchyRollup(deps, { measureId: "audiogram" });

  console.log(JSON.stringify({
    allEvaluated: root.totals.evaluated,
    audiogramEvaluated: audiogramRoot.totals.evaluated,
    allOpenCases: root.totals.openCases,
  }));
`;

test("scoped profile (Maui) — hierarchy rollup scopes to runnable measures", () => {
  const output = runProfileChild("maui", testScript);
  assert.equal(output.allEvaluated, 1, "Maui profile rollup only includes runnable measures (cms122 for pat-001)");
  assert.equal(output.audiogramEvaluated, 0, "audiogram measure is not runnable on Maui profile");
});

test("scoped profile (Maui) — hierarchy rollup excludes open cases for unrunnable measures", () => {
  const output = runProfileChild("maui", testScript);
  assert.equal(output.allOpenCases, 0, "Maui must not count an open audiogram case when audiogram is unrunnable");
});

test("default profile — hierarchy rollup includes all active measures", () => {
  const output = runProfileChild(undefined, testScript);
  assert.equal(output.allEvaluated, 2, "default profile counts cms122 and audiogram; an unresolvable subject has no node, exactly as before this change");
  assert.equal(output.audiogramEvaluated, 1, "audiogram measure rollup evaluated on default profile");
  assert.equal(output.allOpenCases, 1, "default profile preserves the open audiogram case");
});

test("scoped profile (Maui) — hierarchy scale rollup excludes hidden tenant and unrunnable measures", () => {
  const source = `
    import { buildHierarchyRollup } from "./src/program/hierarchy-rollup.ts";

    const runs = [
      { id: "scale-cms122", scopeId: "cms122", triggeredBy: "seed:scale", status: "COMPLETED", startedAt: "2026-07-17T00:00:00.000Z" },
      { id: "scale-audiogram", scopeId: "audiogram", triggeredBy: "seed:scale", status: "COMPLETED", startedAt: "2026-07-18T00:00:00.000Z" },
    ];
    const deps = {
      outcomeStore: {
        listLatestPopulationOutcomes: async () => [],
        listOutcomesWithRun: async () => [],
        aggregateScaleRun: async (runId) => [{ status: "COMPLIANT", count: runId === "scale-cms122" ? 5 : 7 }],
      },
      caseStore: { listCases: async () => [] },
      runStore: { listRuns: async () => runs },
      webChartEnv: {},
    };
    const root = await buildHierarchyRollup(deps, {});
    const mhn = await buildHierarchyRollup(deps, { tenant: "mhn" });
    console.log(JSON.stringify({ root: root.totals.evaluated, mhn: mhn.totals.evaluated }));
  `;

  const mauiOutput = runProfileChild("maui", source);
  assert.equal(mauiOutput.root, 0, "Maui must not include the hidden mhn scale tenant");
  assert.equal(mauiOutput.mhn, 0, "Maui must not expose the hidden mhn subtree even when explicitly requested");

  const defaultOutput = runProfileChild(undefined, source);
  assert.equal(defaultOutput.root, 12, "default profile retains scale counts for active measures");
  assert.equal(defaultOutput.mhn, 12, "default profile retains the mhn scale subtree");
});
