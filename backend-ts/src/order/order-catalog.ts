/**
 * Action evaluators (#77 E7): runnable measure → the order to propose for an at-risk member.
 * Codes are representative (demo, not billing-certified) and REUSE the terminology_mappings seed
 * where present (value-set-seed.ts): audiogram→CPT 92557, tb_surveillance→CPT 86580, flu_vaccine→CVX 141.
 * A measure absent here yields no proposal (extension-safe).
 *
 * System URI constants verified against backend-ts/src/measure/value-set-seed.ts:
 *   CPT = "http://www.ama-assn.org/go/cpt"  (matches seed const CPT)
 *   CVX = "http://hl7.org/fhir/sid/cvx"      (matches seed const CVX)
 */
import type { OrderCode } from "./proposed-order.ts";

const CPT = "http://www.ama-assn.org/go/cpt";
const CVX = "http://hl7.org/fhir/sid/cvx";
const LOCAL = "urn:workwell:orders";

export const ORDER_CATALOG: Record<string, OrderCode> = {
  audiogram: { code: "92557", system: CPT, display: "Comprehensive audiometry evaluation" },
  tb_surveillance: { code: "86580", system: CPT, display: "TB intradermal skin test" },
  flu_vaccine: { code: "141", system: CVX, display: "Influenza seasonal injectable" },
  adult_immunization: { code: "115", system: CVX, display: "Tdap vaccine" },
  diabetes_hba1c: { code: "83036", system: CPT, display: "Hemoglobin A1c" },
  cms122: { code: "83036", system: CPT, display: "Hemoglobin A1c" },
  cholesterol_ldl: { code: "80061", system: CPT, display: "Lipid panel" },
  cms125: { code: "77067", system: CPT, display: "Screening mammography, bilateral" },
  hypertension: { code: "99473", system: CPT, display: "Self-measured blood pressure" },
  obesity_bmi: { code: "bmi-screening", system: LOCAL, display: "BMI screening & counseling" },
  hazwoper: { code: "hazwoper-surveillance-exam", system: LOCAL, display: "HAZWOPER medical surveillance exam" },
};

export function orderForMeasure(measureId: string): OrderCode | null {
  return ORDER_CATALOG[measureId] ?? null;
}
