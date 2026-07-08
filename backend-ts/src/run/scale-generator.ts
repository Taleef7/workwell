/**
 * Scale-subject generator seam (batch CQL evaluation of the `mhn` population-scale tenant).
 *
 * The batch engine turns (subjectId, measureId, target, evaluationDate) into an evaluatable
 * FHIR bundle via a `ScaleSubjectGenerator`. Phase 1 reuses the proven synthetic machinery
 * (`deriveExamConfig` + `buildSyntheticBundle`, urn:workwell-coded), evaluated on the engine's
 * direct path. A later unit adds a WebChart-real-coded generator behind the same seam — so the
 * interface stays transport/coding-agnostic.
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { deriveExamConfig, type TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle, type FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";

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

/**
 * Turns (subjectId, measureId, target, evaluationDate) into an evaluatable FHIR bundle. The seam
 * the scale batch engine calls; a WebChart-real-coded implementation drops in behind the same
 * interface in a later unit.
 */
export interface ScaleSubjectGenerator {
  readonly kind: string;
  bundleFor(subjectId: string, measureId: string, target: TargetOutcome, evaluationDate: string): FhirBundle;
}

/**
 * Phase-1 generator: reuses the proven synthetic machinery (`deriveExamConfig` +
 * `buildSyntheticBundle`) to emit a urn:workwell-coded bundle the engine's direct path evaluates.
 * The subjectId IS the FHIR Patient id. Throws on an unknown measure.
 */
export function directSyntheticGenerator(): ScaleSubjectGenerator {
  return {
    kind: "direct-synthetic",
    bundleFor(subjectId, measureId, target, evaluationDate) {
      const binding = MEASURE_BINDINGS[measureId];
      if (!binding) throw new Error(`unknown measure '${measureId}'`);
      const config = deriveExamConfig(binding, target);
      // buildSyntheticBundle reads only externalId + name; the rest of EmployeeProfile is unused here.
      const employee = { externalId: subjectId, name: subjectId } as EmployeeProfile;
      return buildSyntheticBundle(employee, config, evaluationDate);
    },
  };
}
