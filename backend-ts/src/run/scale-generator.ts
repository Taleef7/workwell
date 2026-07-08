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
import { normalizeWebChartBundle } from "../engine/ingress/webchart/normalize.ts";

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

const CVX = "http://hl7.org/fhir/sid/cvx";
const LOINC = "http://loinc.org";
const CPT = "http://www.ama-assn.org/go/cpt";

/**
 * One real, ACTIVE code per measure (audit-verified 2026-07-08; `docs/TERMINOLOGY_AUDIT_2026-07-08.md`).
 * Each code is a verified crosswalk row in `engine/ingress/webchart/terminology.ts`, so the WebChart
 * terminology reconciler maps it back to the synthetic measure-event coding the CQL matches. `hazwoper`
 * is intentionally absent — it has a synthetic-only event code with no real terminology, so its urn:workwell
 * coding is left as-is (it passes through `normalizeWebChartBundle` untouched and the CQL matches it directly).
 */
export const REAL_EVENT_CODE: Record<string, { system: string; code: string }> = {
  audiogram: { system: CPT, code: "92557" },
  tb_surveillance: { system: CPT, code: "86580" },
  cms125: { system: CPT, code: "77067" },
  diabetes_hba1c: { system: LOINC, code: "4548-4" },
  cms122: { system: LOINC, code: "4548-4" },
  cholesterol_ldl: { system: LOINC, code: "2089-1" },
  hypertension: { system: LOINC, code: "8480-6" },
  obesity_bmi: { system: LOINC, code: "39156-5" },
  flu_vaccine: { system: CVX, code: "150" },
  adult_immunization: { system: CVX, code: "115" },
  mmr: { system: CVX, code: "03" },
  varicella: { system: CVX, code: "21" },
  hepatitis_b_vaccination_series: { system: CVX, code: "189" },
};

/**
 * Re-code the qualifying EVENT resource(s) of a synthetic bundle to the measure's real WebChart code.
 * Only the clinical events (`Procedure`/`Immunization`/`Observation`) are re-coded — the enrollment /
 * waiver / refusal `Condition`s keep their synthetic codes (the CQL reads those directly, they carry no
 * real terminology). Never mutates the input; builds new resource objects. A measure with no real code
 * (`hazwoper`) is returned unchanged.
 */
function recodeEventToReal(bundle: FhirBundle, measureId: string): FhirBundle {
  const real = REAL_EVENT_CODE[measureId];
  if (!real) return bundle;
  const EVENT_TYPES = new Set(["Procedure", "Immunization", "Observation"]);
  const entry = bundle.entry.map((e) => {
    const r = e.resource as Record<string, unknown> | undefined;
    if (!r || typeof r.resourceType !== "string" || !EVENT_TYPES.has(r.resourceType)) return e;
    const codeField = r.resourceType === "Immunization" ? "vaccineCode" : "code";
    return { resource: { ...r, [codeField]: { coding: [{ ...real, display: real.code }] } } };
  });
  return { ...bundle, entry };
}

/**
 * Phase-2 generator: emits a bundle carrying REAL LOINC/CVX/CPT codes routed through the WebChart
 * terminology crosswalk — so the scale batch genuinely exercises the real-world WebChart adapter at
 * scale, not just the synthetic direct path.
 *
 * Strategy: build the urn:workwell bundle via the direct generator, re-code its qualifying event to the
 * measure's real code, then run the whole bundle through `normalizeWebChartBundle` (which re-adds the
 * synthetic coding the CQL matches while preserving the real code — and, for a lab Observation feeding a
 * `[Procedure]`-retrieving measure, synthesizes the dated Procedure). Descriptive only (ADR-008): the
 * reconciler never decides compliance; the CQL engine does.
 */
export function webChartRealisticGenerator(): ScaleSubjectGenerator {
  const direct = directSyntheticGenerator();
  return {
    kind: "webchart",
    bundleFor(subjectId, measureId, target, evaluationDate) {
      const synthetic = direct.bundleFor(subjectId, measureId, target, evaluationDate);
      const realCoded = recodeEventToReal(synthetic, measureId);
      return normalizeWebChartBundle(realCoded) as FhirBundle;
    },
  };
}
