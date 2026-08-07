/**
 * Registry of runnable measures → their compiled ELM library + evaluation metadata.
 * Mirrors the catalog in backend's measures/*.yaml (id, name) and the library ids
 * emitted by scripts/compile-measures.mjs. `periodMonths` is the Measurement Period
 * window the Java engine builds: 12 for the season-based flu measure (its CQL uses
 * `occurrence during "Measurement Period"`), single-day (0) for the rest.
 *
 * ADR-059: this file is WorkWell's measure CONTENT and stays app-side. The `MeasureMeta` *shape* is the
 * engine's, so it is re-exported from `@work-well/measure-engine` here — every existing importer keeps its
 * single `from "./measure-registry.ts"` line, and the package ships none of the catalog below.
 */
export type { MeasureMeta } from "@work-well/measure-engine";
import type { MeasureMeta } from "@work-well/measure-engine";

export const MEASURES: Record<string, MeasureMeta> = {
  audiogram: { id: "audiogram", name: "Audiogram", library: "AnnualAudiogramCompleted-1.0.0", periodMonths: 0, expansionLibrary: "AnnualAudiogramCompletedVS-1.0.0", valueSets: ["urn:workwell:vs:audiogram-procedures"] },
  // M-E1's OSHA STS measure is DELIBERATELY ABSENT from this registry — see ADR-065. Registering it
  // here would put it in `RUNNABLE_MEASURE_IDS` and therefore in every population run, where the
  // synthetic corpus cannot produce what it reads: two dated audiograms carrying six LOINC threshold
  // observations each. The rule-params bindings that generate every other measure's corpus data
  // describe a recency window (enrolment + waiver + one event) and cannot express that shape.
  //
  // It is compiled, committed and verified (osha-hearing-sts.test.ts) through the engine's own
  // consumer path — `evaluate({ elm, metaOverride })` — which is exactly how an external integrator
  // would run measure content we do not ship. Corpus generation is named follow-up work, not a gap
  // being hidden: a measure wired into the roster with data that cannot exercise it would report
  // MISSING_DATA for the whole population and look integrated while proving nothing.
  hazwoper: { id: "hazwoper", name: "HAZWOPER Surveillance", library: "HazwoperSurveillance-1.0.0", periodMonths: 0 },
  tb_surveillance: { id: "tb_surveillance", name: "TB Surveillance", library: "TbSurveillance-1.3.0", periodMonths: 0 },
  flu_vaccine: { id: "flu_vaccine", name: "Flu Vaccine", library: "FluVaccineSeasonal-1.0.0", periodMonths: 12 },
  adult_immunization: { id: "adult_immunization", name: "Adult Immunization Status (Td/Tdap)", library: "AdultImmunizationTdap-1.0.0", periodMonths: 0 },
  mmr: { id: "mmr", name: "MMR Immunity (2-dose series)", library: "MmrSeries-1.0.0", periodMonths: 0 },
  varicella: { id: "varicella", name: "Varicella Immunity (2-dose series)", library: "VaricellaSeries-1.0.0", periodMonths: 0 },
  hepatitis_b_vaccination_series: { id: "hepatitis_b_vaccination_series", name: "Hepatitis B Vaccination Series", library: "HepatitisBSeries-1.0.0", periodMonths: 0 },
  hypertension: { id: "hypertension", name: "Hypertension BP Screening", library: "HypertensionBPScreeningCQL-1.0.0", periodMonths: 0 },
  diabetes_hba1c: { id: "diabetes_hba1c", name: "Diabetes HbA1c Monitoring", library: "DiabetesHbA1cMonitoringCQL-1.0.0", periodMonths: 0 },
  obesity_bmi: { id: "obesity_bmi", name: "BMI Screening & Counseling", library: "ObesityBMIScreeningCQL-1.0.0", periodMonths: 0 },
  cholesterol_ldl: { id: "cholesterol_ldl", name: "Cholesterol LDL Screening", library: "CholesterolLDLScreeningCQL-1.0.0", periodMonths: 0 },
  // CMS122v14 / CMS125v14 (2026 eCQI): 12-month measurement period + VSAC expansions (bundled offline).
  cms125: {
    id: "cms125",
    name: "Breast Cancer Screening",
    library: "BreastCancerScreeningCQL-2.0.0",
    expansionLibrary: "BreastCancerScreeningCQL-2.0.0",
    periodMonths: 12,
    valueSets: [
      "2.16.840.1.113883.3.464.1003.108.12.1018",
      "2.16.840.1.113883.3.464.1003.101.12.1001",
      "2.16.840.1.113883.3.526.3.1240",
      "2.16.840.1.113883.3.464.1003.101.12.1025",
      "2.16.840.1.113883.3.464.1003.101.12.1023",
      "2.16.840.1.113883.3.464.1003.101.12.1016",
      "2.16.840.1.113883.3.464.1003.101.12.1080",
      "2.16.840.1.113883.3.464.1003.101.12.1089",
      "2.16.840.1.113883.3.464.1003.1003",
      "2.16.840.1.113883.3.526.3.1584",
      "2.16.840.1.113883.3.464.1003.1165",
      "2.16.840.1.113883.3.464.1003.1167",
      "2.16.840.1.113883.3.464.1003.101.12.1090",
      "2.16.840.1.113883.3.464.1003.198.12.1068",
      "2.16.840.1.113883.3.464.1003.198.12.1005",
      "2.16.840.1.113883.3.464.1003.198.12.1069",
      "2.16.840.1.113883.3.464.1003.198.12.1070",
      "2.16.840.1.113883.3.464.1003.198.12.1133",
      "2.16.840.1.113883.3.464.1003.198.12.1134",
    ],
    jurisdiction: "US",
  },
  cms122: {
    id: "cms122",
    name: "Diabetes: Glycemic Status Assessment Greater Than 9%",
    library: "DiabetesHbA1cPoorControlCQL-2.0.0",
    expansionLibrary: "DiabetesHbA1cPoorControlCQL-2.0.0",
    periodMonths: 12,
    valueSets: [
      "2.16.840.1.113883.3.464.1003.103.12.1001",
      "2.16.840.1.113883.3.464.1003.198.12.1013",
      "2.16.840.1.113883.3.464.1003.101.12.1001",
      "2.16.840.1.113883.3.526.3.1240",
      "2.16.840.1.113883.3.464.1003.101.12.1025",
      "2.16.840.1.113883.3.464.1003.101.12.1023",
      "2.16.840.1.113883.3.464.1003.101.12.1016",
      "2.16.840.1.113883.3.464.1003.101.12.1080",
      "2.16.840.1.113883.3.464.1003.1006",
      "2.16.840.1.113883.3.464.1003.1003",
      "2.16.840.1.113883.3.526.3.1584",
      "2.16.840.1.113883.3.464.1003.1165",
      "2.16.840.1.113883.3.464.1003.1167",
      "2.16.840.1.113883.3.464.1003.101.12.1090",
      "2.16.840.1.113883.3.464.1003.198.12.1135",
    ],
    jurisdiction: "US",
  },
};
