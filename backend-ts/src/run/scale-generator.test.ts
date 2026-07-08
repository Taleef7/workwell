import { strict as assert } from "node:assert";
import { test } from "node:test";

import { evaluateBundle } from "../engine/ingress/evaluate-bundle.ts";
import { directSyntheticGenerator, targetForIndex } from "./scale-generator.ts";

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
