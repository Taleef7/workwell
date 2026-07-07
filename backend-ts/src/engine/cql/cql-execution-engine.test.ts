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
const expectedFor = (measureId: string, scenario: string): string =>
  PERMANENT_MEASURES.has(measureId) && scenario === "present_old" ? "COMPLIANT" : EXPECTED[scenario]!;

const engine = new CqlExecutionEngine();

for (const measureId of Object.keys(MEASURES)) {
  test(`evaluates ${measureId} across all scenarios (no JVM)`, async () => {
    for (const scenario of Object.keys(EXPECTED)) {
      const expected = expectedFor(measureId, scenario);
      const bundle = JSON.parse(readFileSync(path.join(synthRoot, measureId, `${scenario}.json`), "utf8"));
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
