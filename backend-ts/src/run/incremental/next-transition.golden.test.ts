/**
 * #263 Phase 2a — GOLDEN verification that the BOUNDARY_SAFE threshold table matches the REAL CQL.
 *
 * The thresholds in `next-transition.ts` live in the CQL, not the binding, so this test evaluates each
 * boundary-safe measure through the actual `CqlExecutionEngine` at controlled `daysSinceLastExam` and
 * asserts the status flips EXACTLY at the tabled boundaries. If any measure's CQL drifts from its table
 * entry, this fails — the table can never silently lie (design §3 / §8). Also proves the exclusions:
 * `flu_vaccine`/`cms122`/`cms125` are (correctly) NOT in the table.
 *   node --import tsx --test src/run/incremental/next-transition.golden.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../../engine/cql/cql-execution-engine.ts";
import { buildSyntheticBundle } from "../../engine/synthetic/fhir-bundle-builder.ts";
import { EMPLOYEES } from "../../engine/synthetic/employee-catalog.ts";
import { MEASURE_BINDINGS } from "../../engine/synthetic/measure-bindings.ts";
import type { ExamConfig } from "../../engine/synthetic/exam-config.ts";
import { BOUNDARY_SAFE, computeNextTransition } from "./next-transition.ts";

const engine = new CqlExecutionEngine();
const emp = EMPLOYEES[0]!;
const EVAL = "2026-06-15";

const configAt = (measureId: string, days: number | null): ExamConfig => ({
  binding: MEASURE_BINDINGS[measureId]!,
  daysSinceLastExam: days,
  hasWaiver: false,
  programEnrolled: true,
  observationValue: null,
  refused: false,
  doseCount: null,
});

const statusAt = async (measureId: string, days: number): Promise<string> => {
  const bundle = buildSyntheticBundle(emp, configAt(measureId, days), EVAL);
  const r = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL });
  return r.outcome;
};

for (const [measureId, t] of Object.entries(BOUNDARY_SAFE)) {
  test(`${measureId}: CQL flips exactly at the tabled thresholds`, async () => {
    assert.equal(await statusAt(measureId, t.compliantMaxDays), "COMPLIANT", `days=${t.compliantMaxDays} must be COMPLIANT`);
    assert.equal(await statusAt(measureId, t.compliantMaxDays + 1), "DUE_SOON", `days=${t.compliantMaxDays + 1} must be DUE_SOON`);
    assert.equal(await statusAt(measureId, t.overdueMinDays - 1), "DUE_SOON", `days=${t.overdueMinDays - 1} must be DUE_SOON`);
    assert.equal(await statusAt(measureId, t.overdueMinDays), "OVERDUE", `days=${t.overdueMinDays} must be OVERDUE`);
  });
}

test("non-boundary-safe measures are excluded (would be unsafe to reuse across days)", () => {
  for (const id of ["flu_vaccine", "cms122", "cms125"]) {
    assert.equal(BOUNDARY_SAFE[id], undefined, `${id} must not be in BOUNDARY_SAFE`);
    // and computeNextTransition returns the eval date (no across-day reuse) for them
    assert.equal(computeNextTransition(id, "COMPLIANT", { expressionResults: [{ define: "Days Since Last X", result: 10 }] }, "2026-06-15"), "2026-06-15");
  }
});

test("computeNextTransition: COMPLIANT windowed returns the DUE_SOON boundary date", () => {
  // audiogram: compliantMaxDays 335. At days=100 on 2026-06-15, DUE_SOON begins at day 336 → 236 days later.
  const evidence = { expressionResults: [{ define: "Days Since Last Audiogram", result: 100 }] };
  const nt = computeNextTransition("audiogram", "COMPLIANT", evidence, "2026-06-15");
  // 2026-06-15 + 236 days
  const expected = new Date(Date.parse("2026-06-15T00:00:00Z") + 236 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(nt, expected);
});

test("computeNextTransition: OVERDUE and MISSING_DATA are terminal (null)", () => {
  assert.equal(computeNextTransition("audiogram", "OVERDUE", { expressionResults: [{ define: "Days Since Last Audiogram", result: 500 }] }, "2026-06-15"), null);
  assert.equal(computeNextTransition("audiogram", "MISSING_DATA", { expressionResults: [] }, "2026-06-15"), null);
});

test("computeNextTransition: PERMANENT complete/incomplete are terminal; EXCLUDED is not reusable", () => {
  assert.equal(computeNextTransition("mmr", "COMPLIANT", {}, "2026-06-15"), null);
  assert.equal(computeNextTransition("mmr", "MISSING_DATA", {}, "2026-06-15"), null);
  assert.equal(computeNextTransition("mmr", "EXCLUDED", {}, "2026-06-15"), "2026-06-15");
});

test("computeNextTransition: windowed EXCLUDED is not reusable across days (waiver expiry unmodeled)", () => {
  assert.equal(computeNextTransition("audiogram", "EXCLUDED", {}, "2026-06-15"), "2026-06-15");
});
