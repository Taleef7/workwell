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

import {
  renderSnapshot,
  evaluateLikeTheRunPipeline,
  type MeasureSnapshot,
  type BatchAndSingle,
  type SnapshotSubject,
} from "./official-flip-snapshot.ts";

const subjects: SnapshotSubject[] = ["s1", "s2", "s3"].map((subjectId) => ({ subjectId, bundle: { subjectId } }));
const batch = subjects.map((s) => ({ subjectId: s.subjectId, patientBundle: s.bundle }));
const outcome = (inIpp: boolean, status = "OVERDUE") =>
  ({ subjectId: "x", measure: "cms125", outcome: status, inInitialPopulation: inIpp }) as never;

test("ADR-044: a subject OMITTED from the batch is re-evaluated individually, as a run would", async () => {
  // Codex, #355 — and the same incomplete-roster mistake as #354's. `evaluateBatch` deliberately omits a
  // subject it returned nothing for, and `run-pipeline.ts` re-evaluates each one before persisting. A
  // snapshot that skipped that step is not a forecast of the run it claims to forecast: here the omitted
  // subject IS in the initial population, so skipping it would report 0-in-IPP and earn a spurious
  // DO-NOT-FLIP on a roster that is perfectly fine.
  const singles: string[] = [];
  const executor: BatchAndSingle = {
    async evaluateBatch() {
      return new Map([["s1", outcome(false)]]); // s2, s3 omitted
    },
    async evaluate(input) {
      singles.push((input.patientBundle as { subjectId: string }).subjectId);
      return outcome(true, "COMPLIANT");
    },
  };

  const result = await evaluateLikeTheRunPipeline(executor, "cms125", subjects, batch, "2026-07-30");

  assert.deepEqual(singles.sort(), ["s2", "s3"], "exactly the omitted subjects take the fallback");
  assert.equal(result.size, 3, "the roster is complete before anything is tallied");
  assert.equal([...result.values()].filter((o) => o.inInitialPopulation).length, 2);
});

test("ADR-044: the batch result is never overwritten by the fallback", async () => {
  // The fallback must fill gaps, not re-decide subjects the batch already answered — otherwise the
  // snapshot silently stops being a shadow of the batched path the flip actually uses.
  let singleCalls = 0;
  const executor: BatchAndSingle = {
    async evaluateBatch() {
      return new Map(subjects.map((s) => [s.subjectId, outcome(true, "COMPLIANT")]));
    },
    async evaluate() {
      singleCalls++;
      return outcome(false);
    },
  };

  const result = await evaluateLikeTheRunPipeline(executor, "cms125", subjects, batch, "2026-07-30");
  assert.equal(singleCalls, 0, "a complete batch needs no fallback at all");
  assert.equal([...result.values()].every((o) => o.outcome === "COMPLIANT"), true);
});

test("ADR-044: a subject the fallback ALSO fails on is left absent, never invented", async () => {
  const executor: BatchAndSingle = {
    async evaluateBatch() {
      return new Map([["s1", outcome(true)]]);
    },
    async evaluate() {
      throw new Error("terminology unavailable");
    },
  };

  const result = await evaluateLikeTheRunPipeline(executor, "cms125", subjects, batch, "2026-07-30");
  assert.equal(result.size, 1, "a failed subject is reported as missing, not given a fabricated outcome");
});


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
      divergence: { "wc-8": "OVERDUE → COMPLIANT", "wc-36": "OVERDUE → (evaluation failed)" },
    },
  ]);
  assert.match(out, /2 subject\(s\) change/);
  assert.match(out, /`wc-8`: OVERDUE → COMPLIANT/);
  // A subject BOTH paths failed on is reported rather than dropped — silently ignoring it would
  // under-report the flip's effect.
  assert.match(out, /`wc-36`: OVERDUE → \(evaluation failed\)/);
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
