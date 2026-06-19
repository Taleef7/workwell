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
import { employeeById } from "../engine/synthetic/employee-catalog.ts";

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

// ---- deeper coverage (#74 E4 review): multi-child accumulation + open-case-only leaf ----
// Each block builds its OWN sqlite db + stores so it can't disturb the suite-level fixture above.

/** Fresh floor stores on a throwaway sqlite db. Caller deletes the file. */
async function freshStores(dbFile: string) {
  const db = await createSqliteD1(dbFile);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return {
    runStore: new SqliteRunStore(db),
    outcomes: new SqliteOutcomeStore(db),
    cases: new SqliteCaseStore(db),
  };
}

const createAudiogramRun = (runStore: SqliteRunStore) =>
  runStore.createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });

test("multi-child accumulation: a Plant A location totals 2 providers × 2 differing-status patients", async () => {
  // Verify the synthetic attribution we're relying on (Plant A round-robin prov-001/prov-002).
  assert.equal(employeeById("emp-005")?.providerId, "prov-001");
  assert.equal(employeeById("emp-007")?.providerId, "prov-001");
  assert.equal(employeeById("emp-006")?.providerId, "prov-002");
  assert.equal(employeeById("emp-008")?.providerId, "prov-002");
  for (const id of ["emp-005", "emp-006", "emp-007", "emp-008"]) {
    assert.equal(employeeById(id)?.site, "Plant A");
  }

  const dbFile = join(tmpdir(), `workwell-hier-multi-${crypto.randomUUID()}.sqlite`);
  try {
    const { runStore, outcomes: o, cases: c } = await freshStores(dbFile);
    const run = await createAudiogramRun(runStore);
    // prov-001: emp-005 COMPLIANT, emp-007 OVERDUE (1 of 2 compliant → 50%)
    await o.recordOutcome({ runId: run.id, subjectId: "emp-005", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
    await o.recordOutcome({ runId: run.id, subjectId: "emp-007", measureId: "audiogram", status: "OVERDUE", evidence: {} });
    // prov-002: emp-006 COMPLIANT, emp-008 MISSING_DATA (1 of 2 compliant → 50%)
    await o.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
    await o.recordOutcome({ runId: run.id, subjectId: "emp-008", measureId: "audiogram", status: "MISSING_DATA", evidence: {} });

    const root = await buildHierarchyRollup({ outcomeStore: o, caseStore: c }, { measureId: "audiogram" });
    const plantA = root.children.find((n) => n.id === "Plant A")!;
    assert.equal(plantA.level, "location");
    // Parent total is the SUM of two non-equal children, not a trivial single-child pass-through.
    assert.equal(plantA.totals.evaluated, 4);
    assert.equal(plantA.totals.compliant, 2);
    assert.equal(plantA.totals.complianceRate, 50);

    const prov1 = plantA.children.find((n) => n.id === "prov-001")!;
    const prov2 = plantA.children.find((n) => n.id === "prov-002")!;
    assert.equal(prov1.totals.evaluated, 2);
    assert.equal(prov1.totals.compliant, 1);
    assert.equal(prov1.totals.overdue, 1);
    assert.equal(prov1.totals.complianceRate, 50);
    assert.equal(prov2.totals.evaluated, 2);
    assert.equal(prov2.totals.compliant, 1);
    assert.equal(prov2.totals.missingData, 1);
    assert.equal(prov2.totals.complianceRate, 50);

    assertReconciles(root);
  } finally {
    try { rmSync(dbFile, { force: true }); } catch { /* best effort */ }
  }
});

test("open-case-only subject (no outcome row in scope) is a leaf with evaluated:0 openCases:1", async () => {
  // emp-009 is Plant A / prov-001 — verify before relying on it.
  assert.equal(employeeById("emp-009")?.providerId, "prov-001");
  assert.equal(employeeById("emp-009")?.site, "Plant A");

  const dbFile = join(tmpdir(), `workwell-hier-opencase-${crypto.randomUUID()}.sqlite`);
  try {
    const { runStore, outcomes: o, cases: c } = await freshStores(dbFile);
    const run = await createAudiogramRun(runStore);
    // emp-006 has an outcome (keeps the tree non-empty); emp-009 has ONLY an OPEN case, no outcome.
    await o.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
    const created = await c.upsertFromOutcome({
      runId: run.id, subjectId: "emp-009", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
    });
    assert.ok(created && created.status === "OPEN", "emp-009 OPEN case seeded");

    const root = await buildHierarchyRollup({ outcomeStore: o, caseStore: c }, { measureId: "audiogram" });

    // The open-case-only subject still appears as a patient leaf.
    const plantA = root.children.find((n) => n.id === "Plant A")!;
    const prov1 = plantA.children.find((n) => n.id === "prov-001")!;
    const emp009 = prov1.children.find((n) => n.id === "emp-009")!;
    assert.ok(emp009, "emp-009 patient leaf exists");
    assert.equal(emp009.level, "patient");
    assert.equal(emp009.totals.evaluated, 0);
    assert.equal(emp009.totals.openCases, 1);
    assert.equal(emp009.totals.complianceRate, 0);

    // Parents count the open case but NOT a phantom evaluation.
    assert.equal(prov1.totals.openCases, 1);
    assert.equal(prov1.totals.evaluated, 0); // emp-006 (the only evaluated subject) is prov-002
    assert.equal(plantA.totals.openCases, 1);
    assert.equal(plantA.totals.evaluated, 1); // only emp-006 evaluated
    assert.equal(root.totals.openCases, 1);
    assert.equal(root.totals.evaluated, 1);

    assertReconciles(root);
  } finally {
    try { rmSync(dbFile, { force: true }); } catch { /* best effort */ }
  }
});
