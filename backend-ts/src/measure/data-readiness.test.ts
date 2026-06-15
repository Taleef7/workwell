/**
 * Data readiness unit test (#108) — required-element resolution → mapping/freshness + missingness
 * from outcomes → blockers/warnings → overallStatus.
 *   node --import tsx --test src/measure/data-readiness.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeasureRecord } from "../stores/measure-store.ts";
import type { OutcomeStore, MeasureOutcomeRow } from "../stores/outcome-store.ts";
import { computeDataReadiness } from "./data-readiness.ts";

function record(requiredDataElements: string[], measureId = "audiogram"): MeasureRecord {
  return {
    measureId,
    name: measureId,
    policyRef: "OSHA 29 CFR 1910.95",
    owner: "system",
    tags: [],
    versionId: "audiogram-v1.0",
    version: "v1.0",
    status: "Active",
    spec: { description: "", eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" }, exclusions: [], complianceWindow: "Annual", requiredDataElements, testFixtures: [] },
    cqlText: "",
    compileStatus: "COMPILED",
    changeSummary: null,
    approvedBy: null,
    activatedAt: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };
}

/** Stub OutcomeStore returning a fixed measure-outcome history. */
function outcomesStub(rows: Array<{ subjectId: string; status: string }>): OutcomeStore {
  const measureRows: MeasureOutcomeRow[] = rows.map((r) => ({ subjectId: r.subjectId, status: r.status, evaluationPeriod: "2026-06-13", evaluatedAt: "2026-06-13T00:00:00.000Z", evidence: {} }));
  return {
    listOutcomesForMeasure: async () => measureRows,
  } as unknown as OutcomeStore;
}

test("all required elements resolve to MAPPED + FRESH → READY when no missingness", async () => {
  const deps = { outcomes: outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }, { subjectId: "emp-002", status: "OVERDUE" }]) };
  const r = await computeDataReadiness(deps, record(["Last audiogram date", "Role", "Site", "Program enrollment"]));
  assert.equal(r.overallStatus, "READY");
  assert.equal(r.blockers.length, 0);
  assert.equal(r.requiredElements.length, 4);
  const audiogram = r.requiredElements.find((e) => e.canonicalElement === "procedure.audiogram")!;
  assert.equal(audiogram.mappingStatus, "MAPPED");
  assert.equal(audiogram.freshnessStatus, "FRESH");
});

test("'Program enrollment' resolves by measure: audiogram → hearingConservation MAPPED", async () => {
  const deps = { outcomes: outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }]) };
  const r = await computeDataReadiness(deps, record(["Program enrollment"], "audiogram"));
  const enrollment = r.requiredElements[0]!;
  assert.equal(enrollment.canonicalElement, "programEnrollment.hearingConservation");
  assert.equal(enrollment.mappingStatus, "MAPPED");
});

test("'Program enrollment' for a HEDIS measure is UNMAPPED, not mis-certified as hearing-conservation", async () => {
  const deps = { outcomes: outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }]) };
  const r = await computeDataReadiness(deps, record(["Program enrollment"], "hypertension"));
  const enrollment = r.requiredElements[0]!;
  assert.equal(enrollment.canonicalElement, "programEnrollment.hypertension", "measure-specific canonical, not hearingConservation");
  assert.equal(enrollment.mappingStatus, "UNMAPPED");
  assert.equal(r.overallStatus, "NOT_READY");
  assert.ok(r.blockers.some((b) => /Program enrollment.*no source mapping/i.test(b)));
});

test("an unresolvable required element is a blocker → NOT_READY", async () => {
  const deps = { outcomes: outcomesStub([]) };
  const r = await computeDataReadiness(deps, record(["Quantum entanglement level"]));
  assert.equal(r.overallStatus, "NOT_READY");
  assert.ok(r.blockers.some((b) => /no source mapping/i.test(b)));
  assert.equal(r.requiredElements[0]!.mappingStatus, "UNMAPPED");
});

test("missingness > 5% raises a warning on clinical elements → READY_WITH_WARNINGS", async () => {
  // 2 of 3 MISSING_DATA = 67% → warning; clinical element carries the rate + sample subjects.
  const deps = { outcomes: outcomesStub([
    { subjectId: "emp-004", status: "MISSING_DATA" },
    { subjectId: "emp-009", status: "MISSING_DATA" },
    { subjectId: "emp-001", status: "COMPLIANT" },
  ]) };
  const r = await computeDataReadiness(deps, record(["Last audiogram date", "Role"]));
  assert.equal(r.overallStatus, "READY_WITH_WARNINGS");
  assert.ok(r.warnings.some((w) => /missing data outcomes/i.test(w)));
  const clinical = r.requiredElements.find((e) => e.canonicalElement === "procedure.audiogram")!;
  assert.ok(clinical.missingnessRate > 0.05);
  assert.deepEqual(clinical.sampleMissingEmployees, ["emp-004", "emp-009"]);
  // non-clinical element (role) carries no missingness
  const role = r.requiredElements.find((e) => e.canonicalElement === "employee.role")!;
  assert.equal(role.missingnessRate, 0);
});
