/**
 * Contract test for the production CqlExecutionEngine (#106): evaluate every
 * runnable measure × scenario in Node (no JVM) and assert the outcome bucket.
 * Bundles are the same synthetic fixtures proven byte-equal to the Java engine.
 *   node --import tsx --test src/engine/cql/cql-execution-engine.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CqlExecutionEngine, deriveInInitialPopulation } from "./cql-execution-engine.ts";
import { MEASURES } from "./measure-registry.ts";
import { buildSyntheticBundle } from "../synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig, type TargetOutcome } from "../synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../synthetic/measure-bindings.ts";
import { EMPLOYEES } from "../synthetic/employee-catalog.ts";

const synthRoot = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const EVAL = "2026-06-12";
const EXPECTED: Record<string, string> = {
  present_recent: "COMPLIANT",
  present_old: "OVERDUE",
  missing: "MISSING_DATA",
  excluded: "EXCLUDED",
};

// PERMANENT measures have no recency window — old doses stay COMPLIANT (the "compliant forever" proof).
const PERMANENT_MEASURES = new Set(["mmr", "varicella", "hepatitis_b_vaccination_series"]);
// eCQI-faithful CMS measures: use the dual-coded synthetic builder (spike fixtures predate VSAC dual-coding).
// Missing lab/mammogram while in IPP is the eCQM numerator (poor performance) → OVERDUE, not MISSING_DATA.
const ECQM_MEASURES = new Set(["cms122", "cms125"]);
const ECQM_SCENARIO_TARGET: Record<string, TargetOutcome> = {
  present_recent: "COMPLIANT",
  present_old: "COMPLIANT", // still has a qualifying event in-window for eCQM builders
  missing: "MISSING_DATA",
  excluded: "EXCLUDED",
};
const ECQM_EXPECTED: Record<string, Record<string, string>> = {
  cms122: {
    present_recent: "COMPLIANT",
    present_old: "COMPLIANT",
    missing: "OVERDUE", // missing glycemic assessment is numerator
    excluded: "EXCLUDED",
  },
  cms125: {
    present_recent: "COMPLIANT",
    present_old: "COMPLIANT",
    missing: "OVERDUE", // no mammogram in IPP is non-numerator
    excluded: "EXCLUDED",
  },
};

const expectedFor = (measureId: string, scenario: string): string => {
  if (ECQM_MEASURES.has(measureId)) return ECQM_EXPECTED[measureId]![scenario]!;
  if (PERMANENT_MEASURES.has(measureId) && scenario === "present_old") return "COMPLIANT";
  return EXPECTED[scenario]!;
};

const engine = new CqlExecutionEngine();
const emp = EMPLOYEES[0]!;

for (const measureId of Object.keys(MEASURES)) {
  test(`evaluates ${measureId} across all scenarios (no JVM)`, async () => {
    for (const scenario of Object.keys(EXPECTED)) {
      const expected = expectedFor(measureId, scenario);
      let bundle: unknown;
      if (ECQM_MEASURES.has(measureId)) {
        const target = ECQM_SCENARIO_TARGET[scenario]!;
        const config = deriveExamConfig(MEASURE_BINDINGS[measureId]!, target);
        bundle = buildSyntheticBundle(emp, config, EVAL);
      } else {
        bundle = JSON.parse(readFileSync(path.join(synthRoot, measureId, `${scenario}.json`), "utf8"));
      }
      const outcome = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL });
      assert.equal(outcome.outcome, expected, `${measureId}/${scenario}`);
      assert.equal(outcome.measure, MEASURES[measureId]!.name);
      assert.ok(outcome.evidence.expressionResults.some((r) => r.define === "Outcome Status"));
    }
  });
}

test("adult_immunization refusal keeps the case open (OVERDUE) and flags Refused", async () => {
  const bundle = JSON.parse(readFileSync(path.join(synthRoot, "adult_immunization", "present_old.json"), "utf8"));
  bundle.entry.push({
    resource: {
      resourceType: "Condition",
      id: "adult_immunization-present_old-rfs",
      subject: { reference: "Patient/adult_immunization-present_old" },
      code: { coding: [{ system: "urn:workwell:vs:tdap-refusal", code: "tdap-refusal" }] },
    },
  });
  const outcome = await engine.evaluate({ measureId: "adult_immunization", patientBundle: bundle, evaluationDate: EVAL });
  assert.equal(outcome.outcome, "OVERDUE");
  assert.equal(outcome.evidence.expressionResults.find((r) => r.define === "Refused")?.result, true);
});

test("deriveInInitialPopulation (L17): boolean define → value; absent / non-boolean → undefined (field omitted)", () => {
  assert.equal(deriveInInitialPopulation({ "Initial Population": true }), true);
  assert.equal(deriveInInitialPopulation({ "Initial Population": false }), false);
  assert.equal(deriveInInitialPopulation({}), undefined); // a measure with no IPP define
  assert.equal(deriveInInitialPopulation({ "Initial Population": "yes" }), undefined); // non-boolean → unknown
  assert.equal(deriveInInitialPopulation({ "Initial Population": null }), undefined);
});
