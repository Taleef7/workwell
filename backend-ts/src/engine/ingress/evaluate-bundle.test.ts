/**
 * E12 PR-1 (#184): the DB-less JSON-bundle library entry — single (evaluateBundle) + batch
 * (evaluateBatch with per-item error isolation). Fixtures are the real spike/synthetic bundles.
 *   node --import tsx --test src/engine/ingress/evaluate-bundle.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateBundle, evaluateBatch } from "./evaluate-bundle.ts";
import { createWorkwellEngine } from "../cql/workwell-engine.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

test("evaluateBundle: a single JSON bundle → MeasureOutcome, identical to the engine directly", async () => {
  const bundle = load("audiogram", "present_recent");
  const got = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL });
  assert.equal(got.outcome, "COMPLIANT");
  assert.equal(got.subjectId, "audiogram-present_recent");
  const direct = await createWorkwellEngine().evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: EVAL });
  assert.deepEqual(got, direct); // the library entry adds no behavior
});

test("evaluateBundle: surfaces Initial Population membership — out-of-population ≠ in-population MISSING_DATA (L17)", async () => {
  // An enrolled subject is in the Initial Population (even when COMPLIANT / MISSING_DATA for lack of data).
  const enrolled = await evaluateBundle(load("audiogram", "missing"), "audiogram", { evaluationDate: EVAL });
  assert.equal(enrolled.outcome, "MISSING_DATA");
  assert.equal(enrolled.inInitialPopulation, true); // enrolled but no exam → genuinely missing data

  // A subject NOT enrolled (no program Condition) is OUT of the population — same MISSING_DATA bucket,
  // but the signal distinguishes "not in the program" from "in the program, missing data".
  const outOfPop = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "wc-x" } },
      {
        resource: {
          resourceType: "Procedure", status: "completed", subject: { reference: "Patient/wc-x" },
          code: { coding: [{ system: "urn:workwell:vs:audiogram-procedures", code: "audiogram-procedure" }] },
          performedDateTime: "2026-03-01",
        },
      },
    ],
  };
  const got = await evaluateBundle(outOfPop, "audiogram", { evaluationDate: EVAL });
  assert.equal(got.outcome, "MISSING_DATA");
  assert.equal(got.inInitialPopulation, false);
});

test("evaluateBundle: unknown measure propagates the engine error", async () => {
  await assert.rejects(() => evaluateBundle(load("audiogram", "present_recent"), "nope", { evaluationDate: EVAL }), /unknown measure 'nope'/);
});

test("evaluateBatch: a bucket of bundles → one result each, with per-bundle error isolation", async () => {
  const ok1 = load("audiogram", "present_recent");
  const ok2 = load("audiogram", "present_old");
  const bad = {}; // no Patient → engine throws; must NOT abort the batch
  const res = await evaluateBatch([ok1, bad, ok2], "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 3);
  assert.equal(res.succeeded, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.results[0]?.ok, true);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
  assert.equal(res.results[1]?.ok, false);
  assert.ok((res.results[1]?.error ?? "").length > 0);
  assert.equal(res.results[2]?.ok, true);
  assert.equal(res.results[2]?.outcome?.outcome, "OVERDUE");
});

test("evaluateBatch: empty bucket → zero totals", async () => {
  const res = await evaluateBatch([], "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 0);
  assert.equal(res.succeeded, 0);
  assert.equal(res.failed, 0);
  assert.equal(res.results.length, 0);
});

test("evaluateBatch: unknown measure fails fast (throws once) — not one failed item per bundle", async () => {
  // A mistyped measureId is a global caller/config error, not per-bundle data: it must throw up front
  // (matching the single-bundle path), not degrade into N failed items.
  await assert.rejects(
    () => evaluateBatch([load("audiogram", "present_recent"), load("audiogram", "missing")], "nope", { evaluationDate: EVAL }),
    /unknown measure 'nope'/,
  );
  // ...and an empty bucket with a bad measure rejects rather than reporting success.
  await assert.rejects(() => evaluateBatch([], "nope", { evaluationDate: EVAL }), /unknown measure 'nope'/);
});

/**
 * The batch loop hands the event loop a turn between bundles (#563).
 *
 * `await` on a sync-resolving promise is a MICROTASK, and Node drains the microtask queue before it
 * reaches the timers or poll phase — so a chain of them starves every pending callback for the whole
 * batch. That is why `GET /api/version`, which opens no database connection and therefore cannot be
 * waiting for one, went from 0.2 s to 22 s during a nightly run.
 *
 * The assertion is that a callback queued BEFORE the batch runs DURING it. A test that only measured
 * elapsed time would pass against the bug.
 */
const BURN_MS = 2; // real evaluation is ~42 ms/bundle; 2 ms keeps the test quick and past the timer clamp
const syncEngine = (calls: { n: number }) => ({
  evaluate: async () => {
    calls.n += 1;
    // CPU-bound and sync-resolving — exactly the shape that makes the await chain pure microtasks.
    // It has to actually SPEND time, or the batch finishes inside `setTimeout`'s 1 ms floor and the
    // probe below would be measuring the clock rather than starvation (it did, first attempt).
    const end = performance.now() + BURN_MS;
    while (performance.now() < end) { /* busy */ }
    return { outcome: "COMPLIANT", subjectId: `s-${calls.n}` } as never;
  },
});

/** Whether a macrotask queued before the batch got to run before the batch finished. */
async function ranDuringBatch(yieldEvery: number | undefined): Promise<boolean> {
  const calls = { n: 0 };
  let firedAfter: number | null = null;
  const timer = setTimeout(() => { firedAfter = calls.n; }, 0);
  await evaluateBatch(Array.from({ length: 20 }, () => ({})), "audiogram", {
    engine: syncEngine(calls) as never,
    evaluationDate: EVAL,
    ...(yieldEvery === undefined ? {} : { yieldEvery }),
  });
  clearTimeout(timer);
  // Fired at all, and before the last bundle — i.e. genuinely interleaved, not merely "fired".
  return firedAfter !== null && firedAfter < 20;
}

test("evaluateBatch yields to the event loop between bundles, so a pending callback is not starved", async () => {
  assert.equal(await ranDuringBatch(undefined), true, "the DEFAULT yields — a deployment gets this without configuring anything");
  assert.equal(await ranDuringBatch(1), true, "every bundle");
  assert.equal(await ranDuringBatch(5), true, "every fifth");
});

test("evaluateBatch with yieldEvery: 0 does NOT yield — which is what the bug looked like", async () => {
  // Both directions from one mechanism: without this the assertion above could pass for any reason,
  // and this pins that the knob is the thing controlling it.
  assert.equal(await ranDuringBatch(0), false, "the whole batch runs before any pending callback");
});

test("evaluateBatch: yielding changes no result — the same outcomes, in the same order", async () => {
  const bundles = [load("audiogram", "present_recent"), load("audiogram", "missing"), {}];
  const withYield = await evaluateBatch(bundles, "audiogram", { evaluationDate: EVAL, yieldEvery: 1 });
  const without = await evaluateBatch(bundles, "audiogram", { evaluationDate: EVAL, yieldEvery: 0 });
  assert.deepEqual(withYield, without, "ordering and per-item error isolation are unaffected");
  assert.equal(withYield.succeeded, 2);
  assert.equal(withYield.failed, 1, "the empty object still fails, and still in its own slot");
  assert.deepEqual(withYield.results.map((r) => r.index), [0, 1, 2]);
});
