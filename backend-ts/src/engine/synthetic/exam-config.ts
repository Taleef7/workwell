/**
 * Synthetic exam-config derivation (#107 run pipeline) — TS port of the per-employee
 * config logic in com.workwell.compile.CqlEvaluationService (the seeded-outcome path).
 *
 * Given a measure's bindings and a target outcome, produce the deterministic exam config
 * the FHIR bundle builder stamps so the engine re-derives that outcome:
 *   - recency measures: daysSinceLastExam keyed off the compliance window
 *   - observation measures (e.g. CMS122 HbA1c): a numeric value, not a recency window
 *   - EXCLUDED ⇒ a waiver/exemption/exclusion condition is present
 */
import type { MeasureBinding } from "./measure-bindings.ts";

export type TargetOutcome = "COMPLIANT" | "DUE_SOON" | "OVERDUE" | "MISSING_DATA" | "EXCLUDED";

export interface ExamConfig {
  binding: MeasureBinding;
  /** Days before the evaluation date the qualifying event occurred (null = no event). */
  daysSinceLastExam: number | null;
  hasWaiver: boolean;
  programEnrolled: boolean;
  /** For observation-based measures: the numeric result (null = no observation). */
  observationValue: number | null;
}

/**
 * `target` is a distribution BUCKET, not a guaranteed result. The canonical outcome is
 * always the CQL engine's `Outcome Status` (AI/seed never decides compliance). For
 * season-based (flu) and value-based (CMS122) measures, some buckets intentionally
 * converge to a different canonical outcome (e.g. flu DUE_SOON → COMPLIANT, since any
 * in-period shot is compliant; CMS122 DUE_SOON → MISSING_DATA) — exactly as the Java
 * seeded distribution does. Those convergences are pinned in fhir-bundle-builder.test.ts.
 */
export function deriveExamConfig(binding: MeasureBinding, target: TargetOutcome): ExamConfig {
  const hasWaiver = target === "EXCLUDED";

  if (binding.event.type === "observation") {
    // HbA1c-style: outcome is driven by the value (>9% poor control), not recency.
    const observationValue =
      target === "COMPLIANT" || target === "EXCLUDED" ? 7.5 : target === "OVERDUE" ? 10.5 : null;
    return {
      binding,
      daysSinceLastExam: observationValue !== null ? 30 : null,
      hasWaiver,
      programEnrolled: true,
      observationValue,
    };
  }

  const w = binding.complianceWindowDays;
  const daysSinceLastExam =
    target === "COMPLIANT"
      ? Math.trunc(w / 3)
      : target === "DUE_SOON"
        ? w - 10
        : target === "OVERDUE"
          ? w + 60
          : target === "EXCLUDED"
            ? w + 150
            : null; // MISSING_DATA → no event
  return { binding, daysSinceLastExam, hasWaiver, programEnrolled: true, observationValue: null };
}
