import { strict as assert } from "node:assert";
import { test } from "node:test";

import { evaluateBundle } from "../engine/ingress/evaluate-bundle.ts";
import { directSyntheticGenerator, targetForIndex, webChartRealisticGenerator, REAL_EVENT_CODE } from "./scale-generator.ts";

const EVAL_DATE = "2026-06-26";

test("targetForIndex: first round(rate*n) are COMPLIANT, remainder cycles", () => {
  const n = 10;
  const rate = 0.5;
  const got = Array.from({ length: n }, (_, i) => targetForIndex(i, n, rate));
  assert.deepEqual(got, [
    "COMPLIANT",
    "COMPLIANT",
    "COMPLIANT",
    "COMPLIANT",
    "COMPLIANT",
    "OVERDUE",
    "DUE_SOON",
    "MISSING_DATA",
    "EXCLUDED",
    "OVERDUE",
  ]);
});

test("directSyntheticGenerator: exposes kind + throws on unknown measure", () => {
  const gen = directSyntheticGenerator();
  assert.equal(typeof gen.kind, "string");
  assert.throws(() => gen.bundleFor("s1", "not_a_measure", "COMPLIANT", EVAL_DATE));
});

test("directSyntheticGenerator: COMPLIANT audiogram bundle evaluates COMPLIANT", async () => {
  const gen = directSyntheticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|1", "audiogram", "COMPLIANT", EVAL_DATE);
  const outcome = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL_DATE });
  assert.equal(outcome.outcome, "COMPLIANT");
});

test("directSyntheticGenerator: OVERDUE audiogram bundle evaluates OVERDUE", async () => {
  const gen = directSyntheticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|2", "audiogram", "OVERDUE", EVAL_DATE);
  const outcome = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL_DATE });
  assert.equal(outcome.outcome, "OVERDUE");
});

test("directSyntheticGenerator: EXCLUDED audiogram bundle evaluates EXCLUDED", async () => {
  const gen = directSyntheticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|3", "audiogram", "EXCLUDED", EVAL_DATE);
  const outcome = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL_DATE });
  assert.equal(outcome.outcome, "EXCLUDED");
});

// --- Task 5: webChartRealisticGenerator (real LOINC/CVX/CPT codes → crosswalk → CQL match) ---

test("webChartRealisticGenerator: exposes kind='webchart'", () => {
  assert.equal(webChartRealisticGenerator().kind, "webchart");
});

test("webChartRealisticGenerator: COMPLIANT cholesterol_ldl evaluates COMPLIANT and preserves the real LOINC code", async () => {
  const gen = webChartRealisticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|10", "cholesterol_ldl", "COMPLIANT", EVAL_DATE);
  // The real LOINC 2089-1 must survive reconciliation (provenance preserved alongside the synthetic coding).
  assert.ok(JSON.stringify(bundle).includes("2089-1"), "real LOINC 2089-1 is preserved in the bundle");
  const outcome = await evaluateBundle(bundle, "cholesterol_ldl", { evaluationDate: EVAL_DATE });
  assert.equal(outcome.outcome, "COMPLIANT");
});

test("webChartRealisticGenerator: COMPLIANT cms122 (LOINC/Observation value-based) evaluates COMPLIANT", async () => {
  const gen = webChartRealisticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|11", "cms122", "COMPLIANT", EVAL_DATE);
  assert.ok(JSON.stringify(bundle).includes("4548-4"), "real LOINC 4548-4 is preserved in the bundle");
  const outcome = await evaluateBundle(bundle, "cms122", { evaluationDate: EVAL_DATE });
  assert.equal(outcome.outcome, "COMPLIANT");
});

test("webChartRealisticGenerator: COMPLIANT flu_vaccine (CVX/Immunization) evaluates COMPLIANT", async () => {
  const gen = webChartRealisticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|12", "flu_vaccine", "COMPLIANT", EVAL_DATE);
  assert.ok(JSON.stringify(bundle).includes("150"), "real CVX 150 is preserved in the bundle");
  const outcome = await evaluateBundle(bundle, "flu_vaccine", { evaluationDate: EVAL_DATE });
  assert.equal(outcome.outcome, "COMPLIANT");
});

// Every measure in REAL_EVENT_CODE must reconcile: a COMPLIANT target routed through the real-code
// crosswalk must NOT collapse to MISSING_DATA (which would mean the real code never matched the CQL).
for (const measureId of Object.keys(REAL_EVENT_CODE)) {
  test(`webChartRealisticGenerator: COMPLIANT ${measureId} reconciles to a non-MISSING_DATA outcome`, async () => {
    const gen = webChartRealisticGenerator();
    const bundle = gen.bundleFor(`mhn|L00|P00|${measureId}`, measureId, "COMPLIANT", EVAL_DATE);
    const outcome = await evaluateBundle(bundle, measureId, { evaluationDate: EVAL_DATE });
    assert.notEqual(
      outcome.outcome,
      "MISSING_DATA",
      `${measureId} COMPLIANT target collapsed to MISSING_DATA — the real code did not reconcile (got ${outcome.outcome})`,
    );
  });
}
