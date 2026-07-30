/**
 * The pre-flip snapshot's REPORT shape (ADR-044 / ADR-043 step 2+4).
 *
 * `renderSnapshot` is tested directly rather than through the executor, deliberately: the computation
 * needs the vendored terminology sidecar and self-skips without it (which is how four tests in this
 * area silently stopped running once already), while the VERDICT logic is pure and must never be
 * skippable. The verdict is the part a human acts on, so it is the part that has to be always-green.
 *
 * The end-to-end path — real artifacts over the committed WebChart fixture — is covered by
 * `devdb-official-eval.test.ts` in the sidecar-gated CI job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderSnapshot, type MeasureSnapshot } from "./official-flip-snapshot.ts";

const base: MeasureSnapshot = {
  measureId: "cms125",
  subjects: 56,
  authored: { MISSING_DATA: 52, OVERDUE: 4 },
  official: { MISSING_DATA: 56 },
  officialInIpp: 0,
  authoredActionable: 4,
  divergence: {},
};

test("DO NOT FLIP when official admits nobody but authored finds actionable subjects", () => {
  // The exact measured state that motivated ADR-042/043: official CMS125 put all 56 subjects out of the
  // IPP for want of `us-core-sex`, while authored found four actionable women in the SAME bundles. That
  // asymmetry is the whole signal — it is what makes "this cohort is ineligible" demonstrably false.
  const out = renderSnapshot([base]);
  assert.match(out, /DO NOT FLIP/);
  assert.match(out, /4 actionable subject/);
  assert.match(out, /WEBCHART_FHIR_MAPPING\.md/, "point at the known cause so the verdict is actionable");
});

test("INCONCLUSIVE when BOTH engines find nobody — the shapes are identical and a human decides", () => {
  // cms122 over WebChart data: zero Conditions in the seed, so neither engine can see a denominator.
  // A tool that called this "DO NOT FLIP" would be asserting the discrimination ADR-043 says cannot be
  // made from shape alone — and one that called it "safe" would hide a data gap.
  const out = renderSnapshot([{ ...base, measureId: "cms122", authored: { MISSING_DATA: 56 }, authoredActionable: 0 }]);
  assert.match(out, /INCONCLUSIVE/);
  assert.doesNotMatch(out, /DO NOT FLIP/);
  assert.match(out, /inert rather than wrong/);
});

test("a healthy flip reports no verdict and names it inert when nothing changes", () => {
  const out = renderSnapshot([
    { ...base, official: { MISSING_DATA: 52, OVERDUE: 4 }, officialInIpp: 4, divergence: {} },
  ]);
  assert.doesNotMatch(out, /DO NOT FLIP|INCONCLUSIVE/);
  assert.match(out, /No subject's roster row changes/);
});

test("every changed subject is named with its before and after", () => {
  const out = renderSnapshot([
    {
      ...base,
      official: { MISSING_DATA: 52, COMPLIANT: 1, OVERDUE: 3 },
      officialInIpp: 4,
      divergence: { "wc-8": "OVERDUE → COMPLIANT", "wc-36": "OVERDUE → (not returned)" },
    },
  ]);
  assert.match(out, /2 subject\(s\) change/);
  assert.match(out, /`wc-8`: OVERDUE → COMPLIANT/);
  // An omitted subject is reported rather than dropped — the executor omits subjects it returned nothing
  // for, and a snapshot that silently ignored them would under-report the flip's effect.
  assert.match(out, /`wc-36`: OVERDUE → \(not returned\)/);
});

test("a refused batch is reported as a refusal, not as an empty distribution", () => {
  // Without this the report would render `{}` for `official` and read like "nothing changes".
  const out = renderSnapshot([{ ...base, official: {}, error: "cms125: retrieved NOTHING for any of 56 subjects" }]);
  assert.match(out, /REFUSED/);
  assert.match(out, /retrieved NOTHING/);
  assert.match(out, /cannot be routed over this data/);
});

test("the single-subject case gets no verdict — one subject out of the IPP is ordinary", () => {
  // Same `> 1` boundary as ADR-043 decision 4: `/simulate` on somebody outside the age band is a correct
  // answer, not a finding.
  const out = renderSnapshot([{ ...base, subjects: 1, authored: { MISSING_DATA: 1 }, authoredActionable: 0 }]);
  assert.doesNotMatch(out, /DO NOT FLIP|INCONCLUSIVE/);
});
