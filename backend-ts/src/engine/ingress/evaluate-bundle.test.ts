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
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

test("evaluateBundle: a single JSON bundle → MeasureOutcome, identical to the engine directly", async () => {
  const bundle = load("audiogram", "present_recent");
  const got = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL });
  assert.equal(got.outcome, "COMPLIANT");
  assert.equal(got.subjectId, "audiogram-present_recent");
  const direct = await new CqlExecutionEngine().evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: EVAL });
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
