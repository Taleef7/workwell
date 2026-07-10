/**
 * Official CMS125v14 reference — "Breast Cancer Screening",
 * eCQM version 14.0.000, steward NCQA, MIPS Quality ID 112, proportion (higher is better).
 * Transcribed from:
 *   - eCQI: https://ecqi.healthit.gov/ecqm/ec/2026/cms0125v14
 *   - QDM HTML: https://ecqi.healthit.gov/sites/default/files/ecqm/measures/CMS125-v14.0.000-QDM.html
 *   (re-verified 2026-07-10; v15/2027 is annual roll-forward — stay on v14 for 2026 demos)
 * Descriptive reference only — never affects a compliance outcome (ADR-008).
 */
import type { OfficialMeasureReference } from "../reference-types.ts";

export const CMS125V14: OfficialMeasureReference = {
  measureId: "cms125",
  ecqmId: "CMS125v14",
  title: "Breast Cancer Screening",
  version: "14.0.000",
  steward: "NCQA",
  scoring: "proportion",
  omissionSummary: "66+ LTC + frailty/advanced-illness DENEX (Phase 2)",
  provenance: {
    sourceUrl: "https://ecqi.healthit.gov/ecqm/ec/2026/cms0125v14",
    frozenCodesUrl: "https://qpp.cms.gov/docs/QPP_quality_measure_specifications/CQM-Measures/2026_Measure_112_MIPSCQM.pdf",
    retrieved: "2026-07-10",
  },
  criteria: [
    {
      population: "IPP",
      key: "female-42-74",
      description: "Women 42–74 years of age by the end of the measurement period (description says 40–74; IPP is 42–74).",
      valueSetOids: [],
      coverage: "COVERED",
      note: "Production cms125 requires Patient.gender = female and AgeInYearsAt(end of MP) 42–74.",
    },
    {
      population: "IPP",
      key: "qualifying-visit",
      description: "A visit during the measurement period (office, AWV, preventive, home, telephone, virtual).",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.101.12.1001",
        "2.16.840.1.113883.3.526.3.1240",
        "2.16.840.1.113883.3.464.1003.101.12.1025",
        "2.16.840.1.113883.3.464.1003.101.12.1023",
        "2.16.840.1.113883.3.464.1003.101.12.1016",
        "2.16.840.1.113883.3.464.1003.101.12.1080",
        "2.16.840.1.113883.3.464.1003.101.12.1089",
      ],
      coverage: "COVERED",
      note: "Period-filtered VSAC encounter retrieves including Virtual Encounter.",
    },
    {
      population: "DENOM",
      key: "denominator-equals-ipp",
      description: "Denominator equals the Initial Population.",
      valueSetOids: [],
      coverage: "COVERED",
      note: "Outcome Status uses Initial Population as the denominator gate.",
    },
    {
      population: "DENEX",
      key: "hospice",
      description: "Patients in hospice care for any part of the measurement period.",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.1003",
        "2.16.840.1.113883.3.526.3.1584",
        "2.16.840.1.113883.3.464.1003.1165",
      ],
      coverage: "COVERED",
      note: "Hospice Encounter + Ambulatory + Diagnosis.",
    },
    {
      population: "DENEX",
      key: "mastectomy",
      description: "Bilateral mastectomy, history of bilateral mastectomy, or evidence of right and left unilateral mastectomy on or before end of MP.",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.198.12.1068",
        "2.16.840.1.113883.3.464.1003.198.12.1005",
        "2.16.840.1.113883.3.464.1003.198.12.1069",
        "2.16.840.1.113883.3.464.1003.198.12.1070",
        "2.16.840.1.113883.3.464.1003.198.12.1133",
        "2.16.840.1.113883.3.464.1003.198.12.1134",
      ],
      coverage: "COVERED",
      note: "History + bilateral procedure + L/R unilateral paths (unspecified-laterality set folded into L/R).",
    },
    {
      population: "DENEX",
      key: "long-term-care-66",
      description: "Patients 66+ living long-term in a nursing home on or before end of MP.",
      valueSetOids: [],
      coverage: "OMITTED",
      note: "Phase 2 residual.",
    },
    {
      population: "DENEX",
      key: "advanced-illness-frailty-66",
      description: "Patients 66+ with frailty who also meet advanced-illness criteria.",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.113.12.1074",
        "2.16.840.1.113883.3.464.1003.110.12.1082",
        "2.16.840.1.113883.3.464.1003.196.12.1510",
      ],
      coverage: "OMITTED",
      note: "Phase 2 residual.",
    },
    {
      population: "DENEX",
      key: "palliative-care",
      description: "Patients receiving palliative care for any part of the measurement period.",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.1167",
        "2.16.840.1.113883.3.464.1003.101.12.1090",
      ],
      coverage: "COVERED",
      note: "Palliative diagnosis + encounter.",
    },
    {
      population: "NUMER",
      key: "mammogram-oct1-window",
      description: "Women with one or more mammograms any time on or between October 1 two years prior to the measurement period and the end of the measurement period.",
      valueSetOids: ["2.16.840.1.113883.3.464.1003.108.12.1018"],
      coverage: "COVERED",
      note: "VSAC Mammography; official Oct-1 interval (not day-count from Now()). Biopsy/US/MRI excluded by set membership.",
    },
    {
      population: "NUMEX",
      key: "numerator-exclusions-none",
      description: "No numerator exclusions.",
      valueSetOids: [],
      coverage: "COVERED",
      note: "Consistent with the official measure.",
    },
  ],
  valueSets: [
    { name: "Mammography", oid: "2.16.840.1.113883.3.464.1003.108.12.1018", concept: "Mammography" },
    { name: "Office Visit", oid: "2.16.840.1.113883.3.464.1003.101.12.1001", concept: "Encounter" },
    { name: "Annual Wellness Visit", oid: "2.16.840.1.113883.3.526.3.1240", concept: "Encounter" },
    { name: "Virtual Encounter", oid: "2.16.840.1.113883.3.464.1003.101.12.1089", concept: "Encounter" },
    { name: "History of bilateral mastectomy", oid: "2.16.840.1.113883.3.464.1003.198.12.1068", concept: "Mastectomy" },
    { name: "Bilateral Mastectomy", oid: "2.16.840.1.113883.3.464.1003.198.12.1005", concept: "Mastectomy" },
    { name: "Hospice Encounter", oid: "2.16.840.1.113883.3.464.1003.1003", concept: "Hospice" },
    { name: "Palliative Care Diagnosis", oid: "2.16.840.1.113883.3.464.1003.1167", concept: "Palliative" },
    { name: "Frailty Diagnosis", oid: "2.16.840.1.113883.3.464.1003.113.12.1074", concept: "Frailty" },
    { name: "Advanced Illness", oid: "2.16.840.1.113883.3.464.1003.110.12.1082", concept: "AdvancedIllness" },
  ],
  workwellValueSetCoverage: [
    { concept: "Mammography", represented: true, workwellValueSet: "2.16.840.1.113883.3.464.1003.108.12.1018", note: "VSAC Mammography + dual-coded CPT 77067." },
    { concept: "Encounter", represented: true, note: "Office/AWV/preventive/home/telephone/virtual." },
    { concept: "Mastectomy", represented: true, note: "History + bilateral + L/R unilateral paths." },
    { concept: "Hospice", represented: true, note: "Hospice Encounter + Ambulatory + Diagnosis." },
    { concept: "Palliative", represented: true, note: "Palliative diagnosis + encounter." },
    { concept: "Frailty", represented: false, note: "Phase 2 residual." },
    { concept: "AdvancedIllness", represented: false, note: "Phase 2 residual." },
  ],
};
