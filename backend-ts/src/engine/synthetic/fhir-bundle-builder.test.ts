/**
 * Generation ↔ evaluation golden test (#107): for each runnable measure + target outcome,
 * derive the exam config → build the synthetic FHIR bundle → evaluate through the JVM-free
 * CQL engine, and assert the engine re-derives the intended outcome. This proves the ported
 * synthetic generator drives the engine exactly like the Java SyntheticFhirBundleBuilder.
 *   node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";
import { deriveExamConfig, type TargetOutcome } from "./exam-config.ts";
import { buildSyntheticBundle } from "./fhir-bundle-builder.ts";
import { employeeById } from "./employee-catalog.ts";

const engine = new CqlExecutionEngine();
const EVAL_DATE = "2026-06-13";
const emp = employeeById("emp-006")!; // Omar Siddiq, Welder, Plant A

async function expectOutcome(measureId: string, target: TargetOutcome) {
  const config = deriveExamConfig(MEASURE_BINDINGS[measureId]!, target);
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);
  const result = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL_DATE });
  assert.equal(result.outcome, target, `${measureId} target ${target} → got ${result.outcome}`);
  assert.equal(result.subjectId, "emp-006");
}

// recency / Procedure (window 365)
test("audiogram (Procedure) generates each target outcome", async () => {
  for (const t of ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"] as TargetOutcome[]) {
    await expectOutcome("audiogram", t);
  }
});

// recency with a non-365 window (180)
test("diabetes_hba1c (Procedure, 180-day window) generates compliant + overdue", async () => {
  await expectOutcome("diabetes_hba1c", "COMPLIANT");
  await expectOutcome("diabetes_hba1c", "OVERDUE");
});

// Immunization + season-based measure (no OVERDUE/DUE_SOON path)
test("flu_vaccine (Immunization) generates compliant / missing / excluded", async () => {
  for (const t of ["COMPLIANT", "MISSING_DATA", "EXCLUDED"] as TargetOutcome[]) {
    await expectOutcome("flu_vaccine", t);
  }
});

// Observation / value-based (HbA1c > 9% poor control)
test("cms122 (Observation, value-based) generates compliant / overdue / missing / excluded", async () => {
  for (const t of ["COMPLIANT", "OVERDUE", "MISSING_DATA", "EXCLUDED"] as TargetOutcome[]) {
    await expectOutcome("cms122", t);
  }
});
