/**
 * Case disposition logic (#107) — pure port of the routing in
 * com.workwell.caseflow.CaseFlowService: an outcome maps to a case disposition,
 * a priority, and a next-action hint.
 */

export type CaseDisposition = "OPEN" | "EXCLUDED" | "RESOLVE";

/** EXCLUDED → an excluded case; DUE_SOON/OVERDUE/MISSING_DATA → an open case; else resolve. */
export function dispositionFor(outcomeStatus: string): CaseDisposition {
  if (outcomeStatus === "EXCLUDED") return "EXCLUDED";
  if (outcomeStatus === "OVERDUE" || outcomeStatus === "DUE_SOON" || outcomeStatus === "MISSING_DATA") return "OPEN";
  return "RESOLVE"; // COMPLIANT (and anything else) closes an existing case
}

export function priorityFor(outcomeStatus: string): "HIGH" | "MEDIUM" | "LOW" {
  switch (outcomeStatus) {
    case "OVERDUE":
      return "HIGH";
    case "MISSING_DATA":
    case "DUE_SOON":
      return "MEDIUM";
    default:
      return "LOW";
  }
}

/**
 * Per-measure next-action noun, keyed by measureId — covers every runnable measure (M1 fix). Any
 * unmapped measure falls back to a generic, measure-agnostic noun, never the old "audiogram" default
 * that mislabeled the 13 non-OSHA measures. "annual" was dropped from the DUE_SOON phrasing because
 * the compliance window varies (biannual HbA1c, 27-month mammogram, 10-year Td/Tdap, permanent series).
 */
export const NEXT_ACTION_LABELS: Record<string, string> = {
  audiogram: "audiogram",
  hazwoper: "HAZWOPER surveillance",
  tb_surveillance: "TB screening",
  flu_vaccine: "flu vaccine",
  hypertension: "blood pressure screening",
  diabetes_hba1c: "HbA1c test",
  obesity_bmi: "BMI screening",
  cholesterol_ldl: "cholesterol (LDL) screening",
  adult_immunization: "Td/Tdap immunization",
  mmr: "MMR immunization",
  varicella: "varicella immunization",
  hepatitis_b_vaccination_series: "hepatitis B vaccination",
  cms125: "mammogram",
  cms122: "HbA1c test",
};

export function nextActionFor(outcomeStatus: string, measureId: string): string {
  const label = NEXT_ACTION_LABELS[measureId] ?? "compliance assessment";
  switch (outcomeStatus) {
    case "OVERDUE":
      return `Escalate ${label} follow-up immediately.`;
    case "MISSING_DATA":
      return `Collect the missing ${label} documentation.`;
    case "DUE_SOON":
      return `Schedule the ${label} before the due date.`;
    case "EXCLUDED":
      return "Review the active waiver and rerun before it expires.";
    default:
      return "No action required.";
  }
}
