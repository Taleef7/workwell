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
} from "@work-well/measure-engine";
import { evaluateBundle } from "./ingress/evaluate-bundle.ts";
import { createWorkwellEngine } from "./cql/workwell-engine.ts";

// ADR-059: the executor no longer manufactures its own engine — the caller supplies the binding, which
// is what carries the measure content. This test lives app-side because it reaches `evaluateBundle`.
const engine = createWorkwellEngine();

const SYNTH = fileURLToPath(new URL("../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

test("resolveMeasureExecutor: defaults to fhir-native; selects sql-pushdown only on explicit opt-in", () => {
  assert.equal(resolveMeasureExecutor({}, engine).kind, "fhir-native");
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "" }, engine).kind, "fhir-native");
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "fhir-native" }, engine).kind, "fhir-native");
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "  " }, engine).kind, "fhir-native"); // blank-after-trim
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "anything-else" }, engine).kind, "fhir-native"); // unknown → default
  assert.equal(resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "sql-pushdown" }, engine).kind, "sql-pushdown");
});

test("fhirNativeExecutor: produces the same outcome as the direct engine path (parity oracle)", async () => {
  // A MeasureExecutor IS an EvaluateMeasureBinding, so it plugs into evaluateBundle's opts.engine seam —
  // no new plumbing. The default executor must not change any outcome — proven across two outcome buckets.
  const executor: MeasureExecutor = fhirNativeExecutor(engine);
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
  const executor = resolveMeasureExecutor({ WORKWELL_MEASURE_EXECUTOR: "sql-pushdown" }, engine); // resolves fine
  await assert.rejects(() => executor.evaluate({ measureId: "audiogram", patientBundle: {}, evaluationDate: EVAL }));
});
