/**
 * Action evaluators (#77 E7): runnable measure → the order to propose for an at-risk member.
 * Codes are representative (demo, not billing-certified). Where a `terminology_mappings` seed entry
 * exists (value-set-seed.ts) we REUSE its standard code + system so a future EH standing-order query
 * deduplicates against the same code: audiogram→CPT 92557, tb_surveillance→CPT 86580, flu_vaccine→CVX
 * 141 (APPROVED), and hazwoper→`hazwoper-exam` in `urn:workwell:vs:hazwoper-exams` (REVIEWED). Measures
 * with no seed mapping use a representative standard code (real CPT/CVX, e.g. adult_immunization→CVX
 * 115, HbA1c→CPT 83036, mammogram→CPT 77067), or a LOCAL `urn:workwell:orders` code where no standard
 * one is appropriate (e.g. BMI). A measure absent here yields no proposal (extension-safe).
 *
 * System URI constants verified against backend-ts/src/measure/value-set-seed.ts:
 *   CPT = "http://www.ama-assn.org/go/cpt"  (matches seed const CPT)
 *   CVX = "http://hl7.org/fhir/sid/cvx"      (matches seed const CVX)
 *   HAZWOPER_VS = "urn:workwell:vs:hazwoper-exams" (matches the seed mapping's standardSystem)
 */
import type { OrderCode } from "./proposed-order.ts";

const CPT = "http://www.ama-assn.org/go/cpt";
const CVX = "http://hl7.org/fhir/sid/cvx";
const HAZWOPER_VS = "urn:workwell:vs:hazwoper-exams";
const LOCAL = "urn:workwell:orders"; // measures with no terminology_mappings seed entry (e.g. BMI)

export const ORDER_CATALOG: Record<string, OrderCode> = {
  audiogram: { code: "92557", system: CPT, display: "Comprehensive audiometry evaluation" },
  tb_surveillance: { code: "86580", system: CPT, display: "TB intradermal skin test" },
  flu_vaccine: { code: "141", system: CVX, display: "Influenza seasonal injectable" },
  adult_immunization: { code: "115", system: CVX, display: "Tdap vaccine" },
  mmr: { code: "03", system: CVX, display: "MMR vaccine" },
  varicella: { code: "21", system: CVX, display: "Varicella vaccine" },
  hepatitis_b_vaccination_series: { code: "08", system: CVX, display: "Hepatitis B vaccine" },
  diabetes_hba1c: { code: "83036", system: CPT, display: "Hemoglobin A1c" },
  cms122: { code: "83036", system: CPT, display: "Hemoglobin A1c" },
  cholesterol_ldl: { code: "80061", system: CPT, display: "Lipid panel" },
  cms125: { code: "77067", system: CPT, display: "Screening mammography, bilateral" },
  hypertension: { code: "99473", system: CPT, display: "Self-measured blood pressure" },
  obesity_bmi: { code: "bmi-screening", system: LOCAL, display: "BMI screening & counseling" },
  hazwoper: { code: "hazwoper-exam", system: HAZWOPER_VS, display: "HAZWOPER medical surveillance exam" },
};

export function orderForMeasure(measureId: string): OrderCode | null {
  return ORDER_CATALOG[measureId] ?? null;
}
