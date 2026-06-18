/**
 * Generation ↔ evaluation golden test (#107): for each runnable measure + seeded target,
 * derive the exam config → build the synthetic FHIR bundle → evaluate through the JVM-free
 * CQL engine, and assert the ACTUAL engine outcome. Proves the ported synthetic generator
 * drives the engine exactly like the Java SyntheticFhirBundleBuilder.
 *
 * The seeded target is a *distribution bucket*, not a guarantee — the canonical outcome is
 * always the CQL result (AI/seed never decides compliance). For season-based (flu) and
 * value-based (cms122) measures, some buckets intentionally converge to a different outcome,
 * exactly as the Java seeded distribution does (it assigns the same buckets and persists the
 * CQL result). Those convergences are pinned below so they can never drift silently.
 *   node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";
import { deriveExamConfig, type TargetOutcome } from "./exam-config.ts";
import { buildSyntheticBundle } from "./fhir-bundle-builder.ts";
import { employeeById } from "./employee-catalog.ts";

const QICORE_BASE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";

/** Every resource in a synthetic bundle must declare a QI-Core profile (#92 / E3.4). */
function assertAllQiCore(bundle: { entry: Array<{ resource: unknown }> }): void {
  for (const entry of bundle.entry) {
    const resource = entry.resource as Record<string, unknown>;
    const meta = resource["meta"] as { profile?: string[] } | undefined;
    assert.ok(meta && Array.isArray(meta.profile) && meta.profile.length > 0,
      `resource ${String(resource["resourceType"])} is missing meta.profile`);
    assert.ok(meta.profile[0]!.startsWith(QICORE_BASE),
      `resource ${String(resource["resourceType"])} profile "${meta.profile[0]}" does not start with "${QICORE_BASE}"`);
  }
}

const engine = new CqlExecutionEngine();
const EVAL_DATE = "2026-06-13";
const emp = employeeById("emp-006")!; // Omar Siddiq, Welder, Plant A

// [measureId, seeded target bucket, expected canonical CQL outcome]
const CASES: Array<[string, TargetOutcome, string]> = [
  // recency / Procedure (window 365): target == actual for every bucket
  ["audiogram", "COMPLIANT", "COMPLIANT"],
  ["audiogram", "DUE_SOON", "DUE_SOON"],
  ["audiogram", "OVERDUE", "OVERDUE"],
  ["audiogram", "MISSING_DATA", "MISSING_DATA"],
  ["audiogram", "EXCLUDED", "EXCLUDED"],
  // recency with a non-365 window (180)
  ["diabetes_hba1c", "COMPLIANT", "COMPLIANT"],
  ["diabetes_hba1c", "OVERDUE", "OVERDUE"],
  // Immunization, season-based: the DUE_SOON bucket is an in-period shot → COMPLIANT
  ["flu_vaccine", "COMPLIANT", "COMPLIANT"],
  ["flu_vaccine", "DUE_SOON", "COMPLIANT"], // convergence (matches Java seeded distribution)
  ["flu_vaccine", "OVERDUE", "OVERDUE"],
  ["flu_vaccine", "MISSING_DATA", "MISSING_DATA"],
  ["flu_vaccine", "EXCLUDED", "EXCLUDED"],
  // Observation, value-based (HbA1c > 9%): the DUE_SOON bucket has no value → MISSING_DATA
  ["cms122", "COMPLIANT", "COMPLIANT"],
  ["cms122", "DUE_SOON", "MISSING_DATA"], // convergence (value-based has no due-soon)
  ["cms122", "OVERDUE", "OVERDUE"],
  ["cms122", "MISSING_DATA", "MISSING_DATA"],
  ["cms122", "EXCLUDED", "EXCLUDED"],
];

for (const [measureId, target, expected] of CASES) {
  test(`${measureId}: seeded ${target} → engine ${expected}`, async () => {
    const config = deriveExamConfig(MEASURE_BINDINGS[measureId]!, target);
    const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);
    const result = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL_DATE });
    assert.equal(result.outcome, expected, `${measureId} seeded ${target} → got ${result.outcome}, expected ${expected}`);
    assert.equal(result.subjectId, "emp-006");
  });
}

// ---------------------------------------------------------------------------
// QI-Core meta.profile structural tests (#92 E3.4 Task 1)
// ---------------------------------------------------------------------------

test("QI-Core profiles: audiogram COMPLIANT bundle (Procedure) — Patient + Condition + Procedure all carry correct meta.profile", () => {
  const config = deriveExamConfig(MEASURE_BINDINGS["audiogram"]!, "COMPLIANT");
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);

  // Universal invariant: every resource in the bundle must carry a QI-Core profile.
  assertAllQiCore(bundle);

  // Patient: required fields + correct profile
  const patientEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Patient",
  );
  assert.ok(patientEntry, "Patient entry must exist");
  const patient = patientEntry.resource as Record<string, unknown>;
  assert.equal((patient["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-patient`);
  assert.ok(patient["id"], "Patient must have id");
  assert.ok(Array.isArray(patient["name"]) && (patient["name"] as unknown[]).length > 0, "Patient must have name");

  // Condition (enrollment): required fields + correct profile
  const conditionEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Condition",
  );
  assert.ok(conditionEntry, "Condition (enrollment) entry must exist for enrolled employee");
  const condition = conditionEntry.resource as Record<string, unknown>;
  assert.equal((condition["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-condition`);
  assert.ok(condition["clinicalStatus"], "Condition must have clinicalStatus");
  assert.ok(condition["verificationStatus"], "Condition must have verificationStatus");
  assert.ok(condition["code"], "Condition must have code");
  assert.ok(condition["subject"], "Condition must have subject");

  // Procedure (qualifying event): required fields + correct profile
  const procedureEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Procedure",
  );
  assert.ok(procedureEntry, "Procedure entry must exist for COMPLIANT audiogram");
  const procedure = procedureEntry.resource as Record<string, unknown>;
  assert.equal((procedure["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-procedure`);
  assert.ok(procedure["status"], "Procedure must have status");
  assert.ok(procedure["code"], "Procedure must have code");
  assert.ok(procedure["subject"], "Procedure must have subject");
});

test("QI-Core profiles: flu_vaccine COMPLIANT bundle (Immunization) — Immunization carries correct meta.profile", () => {
  const config = deriveExamConfig(MEASURE_BINDINGS["flu_vaccine"]!, "COMPLIANT");
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);

  // Universal invariant
  assertAllQiCore(bundle);

  // Immunization: required fields + correct profile
  const immunizationEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Immunization",
  );
  assert.ok(immunizationEntry, "Immunization entry must exist for COMPLIANT flu_vaccine");
  const immunization = immunizationEntry.resource as Record<string, unknown>;
  assert.equal((immunization["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-immunization`);
  assert.ok(immunization["status"], "Immunization must have status");
  assert.ok(immunization["vaccineCode"], "Immunization must have vaccineCode");
  assert.ok(immunization["patient"], "Immunization must have patient");
});

test("QI-Core profiles: cms122 COMPLIANT bundle (Observation) — Observation carries correct meta.profile", () => {
  const config = deriveExamConfig(MEASURE_BINDINGS["cms122"]!, "COMPLIANT");
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);

  // Universal invariant
  assertAllQiCore(bundle);

  // Observation: required fields + correct profile
  const observationEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Observation",
  );
  assert.ok(observationEntry, "Observation entry must exist for COMPLIANT cms122");
  const observation = observationEntry.resource as Record<string, unknown>;
  assert.equal(
    (observation["meta"] as { profile: string[] }).profile[0],
    `${QICORE_BASE}qicore-observation-clinical-result`,
  );
  assert.ok(observation["status"], "Observation must have status");
  assert.ok(observation["code"], "Observation must have code");
  assert.ok(observation["subject"], "Observation must have subject");
});
