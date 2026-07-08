/**
 * Scale-subject generator seam (batch CQL evaluation of the `mhn` population-scale tenant).
 *
 * The batch engine turns (subjectId, measureId, target, evaluationDate) into an evaluatable
 * FHIR bundle via a `ScaleSubjectGenerator`. Phase 1 reuses the proven synthetic machinery
 * (`deriveExamConfig` + `buildSyntheticBundle`, urn:workwell-coded), evaluated on the engine's
 * direct path. A later unit adds a WebChart-real-coded generator behind the same seam — so the
 * interface stays transport/coding-agnostic.
 */
import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";

/**
 * Deterministic target distribution for `n` subjects at a given compliant `rate`: the first
 * `round(rate*n)` indices are COMPLIANT, then the remainder cycles the non-compliant buckets.
 */
export function targetForIndex(i: number, n: number, rate: number): TargetOutcome {
  const compliant = Math.round(n * rate);
  if (i < compliant) return "COMPLIANT";
  const order: TargetOutcome[] = ["OVERDUE", "DUE_SOON", "MISSING_DATA", "EXCLUDED"];
  return order[(i - compliant) % order.length]!;
}
