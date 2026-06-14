/**
 * Per-measure target compliance rates (#107) — the synthetic distribution's compliant
 * fraction, mirroring `workwell.evaluation.compliance-rates` in the Java application.yml.
 * Unconfigured measures (e.g. CMS eCQM) fall back to 0.80, matching the Java default.
 */
const COMPLIANCE_RATES: Record<string, number> = {
  audiogram: 0.78,
  tb_surveillance: 0.91,
  hazwoper: 0.65,
  flu_vaccine: 0.84,
  hypertension: 0.72,
  diabetes_hba1c: 0.68,
  obesity_bmi: 0.81,
  cholesterol_ldl: 0.74,
};

export const DEFAULT_COMPLIANCE_RATE = 0.8;

export function complianceRate(rateKey: string): number {
  return COMPLIANCE_RATES[rateKey] ?? DEFAULT_COMPLIANCE_RATE;
}
