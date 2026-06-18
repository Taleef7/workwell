/**
 * Registry of runnable measures → their compiled ELM library + evaluation metadata.
 * Mirrors the catalog in backend's measures/*.yaml (id, name) and the library ids
 * emitted by scripts/compile-measures.mjs. `periodMonths` is the Measurement Period
 * window the Java engine builds: 12 for the season-based flu measure (its CQL uses
 * `occurrence during "Measurement Period"`), single-day (0) for the rest.
 */
export interface MeasureMeta {
  id: string;
  name: string;
  /** ELM file under src/engine/cql/elm (without .elm.json). */
  library: string;
  /** Months before the eval date the Measurement Period starts (0 = single-day). */
  periodMonths: number;
  /** ELM library used in value-set-expansion mode (E3.2); falls back to `library` when absent. */
  expansionLibrary?: string;
  /** Value-set URLs the expansion-mode library references (expanded into the CodeService). */
  valueSets?: string[];
}

export const MEASURES: Record<string, MeasureMeta> = {
  audiogram: { id: "audiogram", name: "Audiogram", library: "AnnualAudiogramCompleted-1.0.0", periodMonths: 0, expansionLibrary: "AnnualAudiogramCompletedVS-1.0.0", valueSets: ["urn:workwell:vs:audiogram-procedures"] },
  hazwoper: { id: "hazwoper", name: "HAZWOPER Surveillance", library: "HazwoperSurveillance-1.0.0", periodMonths: 0 },
  tb_surveillance: { id: "tb_surveillance", name: "TB Surveillance", library: "TbSurveillance-1.3.0", periodMonths: 0 },
  flu_vaccine: { id: "flu_vaccine", name: "Flu Vaccine", library: "FluVaccineSeasonal-1.0.0", periodMonths: 12 },
  hypertension: { id: "hypertension", name: "Hypertension BP Screening", library: "HypertensionBPScreeningCQL-1.0.0", periodMonths: 0 },
  diabetes_hba1c: { id: "diabetes_hba1c", name: "Diabetes HbA1c Monitoring", library: "DiabetesHbA1cMonitoringCQL-1.0.0", periodMonths: 0 },
  obesity_bmi: { id: "obesity_bmi", name: "BMI Screening & Counseling", library: "ObesityBMIScreeningCQL-1.0.0", periodMonths: 0 },
  cholesterol_ldl: { id: "cholesterol_ldl", name: "Cholesterol LDL Screening", library: "CholesterolLDLScreeningCQL-1.0.0", periodMonths: 0 },
  cms125: { id: "cms125", name: "Breast Cancer Screening", library: "BreastCancerScreeningCQL-1.0.0", periodMonths: 0 },
  cms122: { id: "cms122", name: "Diabetes: Glycemic Status Assessment Greater Than 9%", library: "DiabetesHbA1cPoorControlCQL-1.0.0", periodMonths: 0 },
};
