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
