/**
 * #263 Phase 2a — copy-forward evidence recomputation (design §3 option 1 / §8 trap 2).
 *   node --import tsx --test src/run/incremental/evidence-copy-forward.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recomputeEvidenceAsOf, daysElapsed } from "./evidence-copy-forward.ts";

const evidence = {
  expressionResults: [
    { define: "In Hearing Conservation Program", result: true },
    { define: "Has Active Waiver", result: false },
    { define: "Most Recent Audiogram Date", result: "2025-03-10T00:00:00.000Z" },
    { define: "Days Since Last Audiogram", result: 400 },
    { define: "Outcome Status", result: "OVERDUE" },
  ],
};

test("daysElapsed counts whole UTC calendar days", () => {
  assert.equal(daysElapsed("2026-01-01", "2026-01-31"), 30);
  assert.equal(daysElapsed("2026-01-01", "2026-01-01"), 0);
  assert.equal(daysElapsed("2026-02-15", "2026-01-16"), -30);
});

test("same-day reuse returns the evidence unchanged (byte-identical parity)", () => {
  const out = recomputeEvidenceAsOf(evidence, "2026-04-14", "2026-04-14");
  assert.strictEqual(out, evidence); // reference-equal: no work at all
});

test("a later date advances only the Days Since define by the elapsed days", () => {
  const out = recomputeEvidenceAsOf(evidence, "2026-04-14", "2026-05-14") as typeof evidence;
  const byName = Object.fromEntries(out.expressionResults.map((r) => [r.define, r.result]));
  assert.equal(byName["Days Since Last Audiogram"], 430); // 400 + 30
  assert.equal(byName["Most Recent Audiogram Date"], "2025-03-10T00:00:00.000Z"); // absolute, unchanged
  assert.equal(byName["Has Active Waiver"], false); // untouched
  assert.equal(byName["Outcome Status"], "OVERDUE"); // status is copied, never recomputed here
});

test("multiple Days Since defines all advance", () => {
  const ev = { expressionResults: [
    { define: "Days Since Last Exam", result: 100 },
    { define: "Days Since Last TB Screen", result: 200 },
    { define: "Most Recent Exam Date", result: "2025-01-01T00:00:00.000Z" },
  ] };
  const out = recomputeEvidenceAsOf(ev, "2026-01-01", "2026-01-11") as typeof ev;
  const byName = Object.fromEntries(out.expressionResults.map((r) => [r.define, r.result]));
  assert.equal(byName["Days Since Last Exam"], 110);
  assert.equal(byName["Days Since Last TB Screen"], 210);
});

test("a MISSING_DATA no-exam Days Since (1900-anchored) still advances linearly", () => {
  // No "Most Recent Date"; the CQL coalesces to @1900-01-01 so Days Since is a huge number that still
  // grows +1/day. The delta approach reproduces that without knowing the fallback anchor.
  const ev = { expressionResults: [{ define: "Days Since Last Audiogram", result: 46_000 }, { define: "Outcome Status", result: "MISSING_DATA" }] };
  const out = recomputeEvidenceAsOf(ev, "2026-01-01", "2026-01-08") as typeof ev;
  assert.equal(out.expressionResults[0]!.result, 46_007);
});

test("non-object evidence and evidence without expressionResults are returned as-is", () => {
  assert.equal(recomputeEvidenceAsOf(null, "2026-01-01", "2026-02-01"), null);
  const noEr = { evaluationError: "x" };
  assert.strictEqual(recomputeEvidenceAsOf(noEr, "2026-01-01", "2026-02-01"), noEr);
});

test("other evidence keys are preserved alongside a recomputed expressionResults", () => {
  const ev = { extra: { a: 1 }, expressionResults: [{ define: "Days Since Last X", result: 5 }] };
  const out = recomputeEvidenceAsOf(ev, "2026-01-01", "2026-01-02") as typeof ev;
  assert.deepEqual(out.extra, { a: 1 });
  assert.equal(out.expressionResults[0]!.result, 6);
});
