/**
 * Hierarchy rollup (#74 E4): seed outcomes/cases via the floor stores, then assert the
 * enterprise→location→provider→patient tree reconciles (parent totals = Σ children) at every
 * level and computes per-level complianceRate/openCases correctly.
 *   node --import tsx --test src/program/hierarchy-rollup.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { buildHierarchyRollup, type HierarchyNode } from "./hierarchy-rollup.ts";

const dbPath = join(tmpdir(), `workwell-hier-${crypto.randomUUID()}.sqlite`);
let outcomes: SqliteOutcomeStore;
let cases: SqliteCaseStore;

const COUNT_KEYS = ["evaluated", "compliant", "dueSoon", "overdue", "missingData", "excluded", "openCases"] as const;

function assertReconciles(node: HierarchyNode): void {
  if (node.children.length > 0) {
    for (const k of COUNT_KEYS) {
      const sum = node.children.reduce((acc, c) => acc + c.totals[k], 0);
      assert.equal(node.totals[k], sum, `${node.level}:${node.id} ${k} = Σ children`);
    }
  }
  const t = node.totals;
  const expectedRate = t.evaluated === 0 ? 0 : Math.round((t.compliant / t.evaluated) * 1000) / 10;
  assert.equal(t.complianceRate, expectedRate, `${node.level}:${node.id} rate recomputed`);
  node.children.forEach(assertReconciles);
}

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runStore = new SqliteRunStore(db);
  outcomes = new SqliteOutcomeStore(db);
  cases = new SqliteCaseStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-010", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("rollup reconciles at every level and the root totals the population", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  assert.equal(root.level, "enterprise");
  assert.equal(root.totals.evaluated, 3);
  assert.equal(root.totals.compliant, 2);
  assert.equal(root.totals.overdue, 1);
  assert.equal(root.totals.openCases, 1);
  assert.equal(root.totals.complianceRate, 66.7);
  assertReconciles(root);
});

test("levels are enterprise→location→provider→patient and a patient maps to its provider's location", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  const plantA = root.children.find((c) => c.id === "Plant A")!;
  assert.equal(plantA.level, "location");
  assert.equal(plantA.totals.evaluated, 2);
  const provider = plantA.children[0]!;
  assert.equal(provider.level, "provider");
  const patient = provider.children[0]!;
  assert.equal(patient.level, "patient");
  assert.ok(["emp-006", "emp-010"].includes(patient.id));
});

test("empty scope (unknown measure) → enterprise node with zeros and no children", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "does-not-exist" });
  assert.equal(root.level, "enterprise");
  assert.equal(root.totals.evaluated, 0);
  assert.equal(root.totals.complianceRate, 0);
  assert.equal(root.children.length, 0);
});

test("omitting measureId aggregates across all Active measures (no crash, reconciles)", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, {});
  assert.ok(root.totals.evaluated >= 3);
  assertReconciles(root);
});
