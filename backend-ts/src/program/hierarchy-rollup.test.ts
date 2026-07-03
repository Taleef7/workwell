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
import { encodeScaleSubject } from "../engine/synthetic/scale-structure.ts";

/** Drill from the All-Systems root to the twh tenant's enterprise node (locations live under it). */
function twhEnterprise(root: HierarchyNode): HierarchyNode {
  const twh = root.children.find((c) => c.id === "twh")!;
  return twh.children.find((c) => c.level === "enterprise")!;
}

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
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", status: "COMPLETED",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-010", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("rollup reconciles at every level and the All-Systems root totals the population", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  assert.equal(root.level, "all");
  assert.equal(root.id, "all");
  assert.equal(root.totals.evaluated, 3);
  assert.equal(root.totals.compliant, 2);
  assert.equal(root.totals.overdue, 1);
  assert.equal(root.totals.openCases, 1);
  assert.equal(root.totals.complianceRate, 66.7);
  // only twh subjects were seeded → exactly one tenant child, all tenant nodes
  assert.ok(root.children.every((c) => c.level === "tenant"));
  const twh = root.children.find((c) => c.id === "twh")!;
  assert.equal(twh.level, "tenant");
  assert.equal(twh.children[0]!.level, "enterprise");
  assertReconciles(root);
});

test("levels are all→tenant→enterprise→location→provider→patient and a patient maps to its provider's location", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  const plantA = twhEnterprise(root).children.find((c) => c.id === "Plant A")!;
  assert.equal(plantA.level, "location");
  assert.equal(plantA.totals.evaluated, 2);
  const provider = plantA.children[0]!;
  assert.equal(provider.level, "provider");
  const patient = provider.children[0]!;
  assert.equal(patient.level, "patient");
  assert.ok(["emp-006", "emp-010"].includes(patient.id));
});

test("empty scope (unknown measure) → All-Systems node with zeros and no children", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "does-not-exist" });
  assert.equal(root.level, "all");
  assert.equal(root.totals.evaluated, 0);
  assert.equal(root.totals.complianceRate, 0);
  assert.equal(root.children.length, 0);
});

test("omitting measureId aggregates across all Active measures (no crash, reconciles)", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, {});
  assert.ok(root.totals.evaluated >= 3);
  assertReconciles(root);
});

test("default root is the All-Systems aggregate over tenants, reconciling at every level", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  assert.equal(root.level, "all");
  assert.ok(root.children.every((c) => c.level === "tenant"));
  assertReconciles(root);
});

test("?tenant=twh returns the twh tenant subtree as root, totals = its slice of the unfiltered tree", async () => {
  const all = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  const sub = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram", tenant: "twh" });
  assert.equal(sub.level, "tenant");
  assert.equal(sub.id, "twh");
  const twhInAll = all.children.find((c) => c.id === "twh")!;
  assert.equal(sub.totals.evaluated, twhInAll.totals.evaluated);
  assert.equal(sub.totals.compliant, twhInAll.totals.compliant);
  assertReconciles(sub);
});

test("?tenant=ihn (no seeded ihn outcomes) → empty tenant root with zeros", async () => {
  const sub = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram", tenant: "ihn" });
  assert.equal(sub.level, "tenant");
  assert.equal(sub.id, "ihn");
  assert.equal(sub.totals.evaluated, 0);
  assert.equal(sub.children.length, 0);
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

test("E13 PR-2: merges the SQL-aggregated mhn scale subtree and reconciles; ?tenant=mhn isolates it", async () => {
  const dbFile = join(tmpdir(), `workwell-hier-scale-${crypto.randomUUID()}.sqlite`);
  try {
    const { runStore, outcomes: o, cases: c } = await freshStores(dbFile);
    // live audiogram run: emp-006 OVERDUE (a twh subject in the directory)
    const live = await createAudiogramRun(runStore);
    await o.recordOutcome({ runId: live.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
    // seed:scale audiogram run: 4 mhn subjects (3 COMPLIANT, 1 OVERDUE) across 2 providers
    const scale = await runStore.createRun({
      scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed:scale", status: "COMPLETED",
      requestedScope: { measureId: "audiogram" },
      measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
    });
    await o.recordOutcomes([
      { runId: scale.id, subjectId: encodeScaleSubject(0, 0, 1), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
      { runId: scale.id, subjectId: encodeScaleSubject(0, 0, 2), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
      { runId: scale.id, subjectId: encodeScaleSubject(0, 1, 3), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
      { runId: scale.id, subjectId: encodeScaleSubject(1, 0, 4), measureId: "audiogram", status: "OVERDUE", evidence: {} },
    ]);

    const root = await buildHierarchyRollup({ outcomeStore: o, caseStore: c, runStore }, { measureId: "audiogram" });
    assert.equal(root.level, "all");
    const mhn = root.children.find((n) => n.id === "mhn")!;
    assert.equal(mhn.level, "tenant");
    assert.equal(mhn.totals.evaluated, 4);
    assert.equal(mhn.totals.compliant, 3);
    // mhn provider nodes are leaves (no patient children)
    const mhnLoc = mhn.children[0]!.children[0]!; // enterprise → first location
    assert.equal(mhnLoc.level, "location");
    assert.equal(mhnLoc.children[0]!.level, "provider");
    assert.equal(mhnLoc.children[0]!.children.length, 0, "scale provider is a leaf");
    // All = Σ tenants (twh live + mhn scale) at every level
    assertReconciles(root);
    assert.equal(root.totals.evaluated, 1 + 4, "live emp-006 + 4 mhn subjects");

    // ?tenant=mhn → just the scale subtree
    const sub = await buildHierarchyRollup({ outcomeStore: o, caseStore: c, runStore }, { measureId: "audiogram", tenant: "mhn" });
    assert.equal(sub.level, "tenant");
    assert.equal(sub.id, "mhn");
    assert.equal(sub.totals.evaluated, 4);

    // the in-memory path must NOT have pulled scale rows: ?tenant=twh excludes mhn entirely
    const twh = await buildHierarchyRollup({ outcomeStore: o, caseStore: c, runStore }, { measureId: "audiogram", tenant: "twh" });
    assert.equal(twh.id, "twh");
    assert.equal(twh.totals.evaluated, 1, "only the live emp-006 subject");
  } finally {
    try { rmSync(dbFile, { force: true }); } catch { /* best effort */ }
  }
});

const createAudiogramRun = (runStore: SqliteRunStore) =>
  runStore.createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    // COMPLETED: the rollup counts only terminal population runs (Fable H7); a QUEUED/RUNNING run's
    // partial rows are excluded, matching production.
    status: "COMPLETED",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });

test("Fable H7: an in-flight RUNNING run's partial outcomes are excluded from the rollup", async () => {
  const dbFile = join(tmpdir(), `workwell-hier-running-${crypto.randomUUID()}.sqlite`);
  try {
    const { runStore, outcomes: o, cases: c } = await freshStores(dbFile);
    // An older COMPLETED run is the real latest TERMINAL state (emp-006 OVERDUE) …
    const done = await createAudiogramRun(runStore);
    await o.recordOutcome({ runId: done.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
    // … while a NEWER RUNNING run (latest by started_at) carries a PARTIAL, misleading COMPLIANT row.
    const running = await runStore.createRun({
      scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", status: "RUNNING",
      requestedScope: { measureId: "audiogram" },
      measurementPeriodStart: "2026-06-14T00:00:00.000Z", measurementPeriodEnd: "2026-06-14T00:00:00.000Z",
    });
    await o.recordOutcome({ runId: running.id, subjectId: "emp-006", measureId: "audiogram", status: "COMPLIANT", evidence: {} });

    const root = await buildHierarchyRollup({ outcomeStore: o, caseStore: c, runStore }, { measureId: "audiogram" });
    // The COMPLETED run wins; the RUNNING run's partial COMPLIANT row is not counted.
    assert.equal(root.totals.evaluated, 1);
    assert.equal(root.totals.overdue, 1);
    assert.equal(root.totals.compliant, 0);
  } finally {
    try { rmSync(dbFile, { force: true }); } catch { /* best effort */ }
  }
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
    const plantA = twhEnterprise(root).children.find((n) => n.id === "Plant A")!;
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

test("Codex P2: an IN_PROGRESS case reconfirmed by a run is still counted as active in the rollup", async () => {
  // The H2 upsert preserves IN_PROGRESS instead of flipping it to OPEN; the active-case count must
  // include IN_PROGRESS or the reconfirmed case silently drops out of openCases.
  assert.equal(employeeById("emp-009")?.providerId, "prov-001");

  const dbFile = join(tmpdir(), `workwell-hier-inprogress-${crypto.randomUUID()}.sqlite`);
  try {
    const { runStore, outcomes: o, cases: c } = await freshStores(dbFile);
    const run = await createAudiogramRun(runStore);
    await o.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
    const created = await c.upsertFromOutcome({
      runId: run.id, subjectId: "emp-009", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
    });
    assert.ok(created, "emp-009 case seeded");
    // An operator moves the case to IN_PROGRESS…
    await c.patchCase(created.id, { status: "IN_PROGRESS" });
    // …and a later run reconfirms the same OVERDUE outcome — H2 preserves IN_PROGRESS.
    const reconfirmed = await c.upsertFromOutcome({
      runId: run.id, subjectId: "emp-009", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
    });
    assert.equal(reconfirmed?.status, "IN_PROGRESS", "IN_PROGRESS preserved by the reconfirm");

    const root = await buildHierarchyRollup({ outcomeStore: o, caseStore: c }, { measureId: "audiogram" });
    assert.equal(root.totals.openCases, 1, "the IN_PROGRESS case is still counted as active");
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
    const plantA = twhEnterprise(root).children.find((n) => n.id === "Plant A")!;
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
