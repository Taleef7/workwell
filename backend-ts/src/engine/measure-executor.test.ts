/**
 * E9 (#78): the MeasureExecutor seam — the FHIR-native executor (default + correctness oracle), the
 * inert SQL-pushdown stub (inert-unless-built), and resolveMeasureExecutor selection. Mirrors the
 * data-source.test.ts shape (ADR-025).
 *   node --import tsx --test src/engine/measure-executor.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  fhirNativeExecutor,
  sqlPushdownExecutor,
  resolveMeasureExecutor,
  type MeasureExecutor,
} from "./measure-executor.ts";
import { evaluateBundle } from "./ingress/evaluate-bundle.ts";

const SYNTH = fileURLToPath(new URL("../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

test("resolveMeasureExecutor: defaults to fhir-native; selects sql-pushdown only on explicit opt-in", () => {
  assert.equal(resolveMeasureExecutor({}).kind, "fhir-native");
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "" }).kind, "fhir-native");
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "fhir-native" }).kind, "fhir-native");
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "  " }).kind, "fhir-native"); // blank-after-trim
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "anything-else" }).kind, "fhir-native"); // unknown → default
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "sql-pushdown" }).kind, "sql-pushdown");
});

test("fhirNativeExecutor: produces the same outcome as the direct engine path (parity oracle)", async () => {
  // A MeasureExecutor IS an EvaluateMeasureBinding, so it plugs into evaluateBundle's opts.engine seam —
  // no new plumbing. The default executor must not change any outcome — proven across two outcome buckets.
  const executor: MeasureExecutor = fhirNativeExecutor();
  assert.equal(executor.kind, "fhir-native");

  for (const [scenario, expected] of [["present_recent", "COMPLIANT"], ["missing", "MISSING_DATA"]] as const) {
    const bundle = load("audiogram", scenario);
    const direct = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL });
    const viaExecutor = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL, engine: executor });
    assert.equal(direct.outcome, expected, `direct ${scenario}`);
    assert.equal(viaExecutor.outcome, direct.outcome, `executor parity ${scenario}`);
  }
});

test("sqlPushdownExecutor: constructs fine but is inert — rejects on use (E9 Option B not built)", async () => {
  const executor = sqlPushdownExecutor();
  assert.equal(executor.kind, "sql-pushdown");
  await assert.rejects(
    () => executor.evaluate({ measureId: "audiogram", patientBundle: {}, evaluationDate: EVAL }),
    /not built.*ADR-025/,
  );
});

test("resolveMeasureExecutor: the opted-in sql-pushdown executor is inert (rejects on use, not on resolve)", async () => {
  const executor = resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "sql-pushdown" }); // resolves fine
  await assert.rejects(() => executor.evaluate({ measureId: "audiogram", patientBundle: {}, evaluationDate: EVAL }));
});
