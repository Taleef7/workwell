/**
 * Generates src/measure/measure-catalog.ts — the full 60-measure TWH catalog (summary +
 * spec) the /measures + /studio pages read — from the Java seed (the single source of truth):
 *   - 49 CMS eCQM entries parsed from MeasureService.CMS_ECQM_CATALOG (47 Draft + generic
 *     spec; CMS125v14/CMS122v14 promoted to Active with their authored spec),
 *   - 8 Active runnable OSHA/HEDIS measures (ids aligned with the engine registry) + their spec,
 *   - 3 OSHA catalog-only measures + spec from V017__seed_additional_measures.sql.
 *
 * Run from backend-ts/:  node scripts/gen-measure-catalog.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const javaSvc = `${here}../../backend/src/main/java/com/workwell/measure/MeasureService.java`;
const outFile = `${here}../src/measure/measure-catalog.ts`;

const elig = (roleFilter, siteFilter, programEnrollmentText) => ({ roleFilter, siteFilter, programEnrollmentText });
const spec = (description, eligibilityCriteria, exclusions, complianceWindow, requiredDataElements) => ({
  description,
  eligibilityCriteria,
  exclusions,
  complianceWindow,
  requiredDataElements,
});

// --- 1. CMS eCQM catalog, parsed from MeasureService.CMS_ECQM_CATALOG ----------
const java = readFileSync(javaSvc, "utf8");
const re = /new CmsEcqmRecord\("(.+?)",\s*"(.+?)",\s*"(.+?)",\s*"\{(.+?)\}"\)/g;
const ACTIVE_CMS = { CMS125v14: "cms125", CMS122v14: "cms122" };
const cms = [];
for (const m of java.matchAll(re)) {
  const [, name, cmsId, mipsId, tagsRaw] = m;
  const active = Object.prototype.hasOwnProperty.call(ACTIVE_CMS, cmsId);
  const id = active ? ACTIVE_CMS[cmsId] : cmsId.toLowerCase();
  cms.push({
    id,
    name,
    policyRef: cmsId,
    version: "v1.0",
    status: active ? "Active" : "Draft",
    owner: "WorkWell Studio",
    tags: tagsRaw.split(",").map((t) => t.trim()),
    compileStatus: active ? "COMPILED" : "NOT_COMPILED",
    // Active CMS measures get their authored spec (below); drafts get the generic catalog spec.
    spec: active
      ? null
      : spec(
          `${cmsId} (MIPS Quality ID ${mipsId}) — CMS eCQM 2026 performance period catalog entry. CQL authoring pending.`,
          elig("", "", ""),
          [],
          "Annual",
          [],
        ),
  });
}
if (cms.length !== 49) throw new Error(`expected 49 CMS catalog entries, parsed ${cms.length}`);

// --- 2. Active runnable OSHA + HEDIS measures (ids aligned with measure-registry) -
const osha = (id, name, policyRef, tags, s) => ({ id, name, policyRef, version: "v1.0", status: "Active", owner: "system", tags, compileStatus: "COMPILED", spec: s });
const runnable = [
  osha("audiogram", "Annual Audiogram Completed", "OSHA 29 CFR 1910.95", ["surveillance", "hearing", "osha"],
    spec("Annual audiogram monitoring for noise-exposed employees.", elig("Maintenance Tech, Welder", "Plant A, Plant B", "Hearing Conservation Program"),
      [{ label: "Waiver", criteriaText: "Valid audiogram waiver on file" }], "Annual", ["Last audiogram date", "Role", "Site", "Program enrollment"])),
  osha("hazwoper", "HAZWOPER Surveillance", "OSHA 29 CFR 1910.120", ["surveillance", "hazmat", "osha"],
    spec("Annual HAZWOPER medical surveillance for hazardous-waste operations employees.", elig("Industrial Hygienist, Maintenance Tech", "Plant A, Plant B", "HAZWOPER Program"),
      [{ label: "Exemption", criteriaText: "Temporary medical exemption documented" }], "Annual", ["Last surveillance exam date", "Role", "Site", "Exemption status"])),
  osha("tb_surveillance", "TB Surveillance", "CDC TB Screening Guidance", ["surveillance", "infection-control", "cdc"],
    spec("Annual TB surveillance for clinic-based nursing and clinic staff.", elig("Nurse, Clinic Staff", "Clinic", "Occupational TB Screening Program"),
      [{ label: "Medical Exemption", criteriaText: "Valid exemption documented" }], "Annual", ["Last TB screening date", "Role", "Site", "Exemption status"])),
  osha("flu_vaccine", "Flu Vaccine", "CDC Seasonal Influenza Guidance", ["vaccine", "seasonal", "immunization"],
    spec("Seasonal influenza vaccination compliance for active employees.", elig("All", "Plant A, Plant B, Clinic", "Seasonal Flu Program"),
      [{ label: "Clinical Contraindication", criteriaText: "Documented contraindication for current season" }], "Seasonal", ["Last flu vaccine date", "Current season", "Contraindication status"])),
  osha("hypertension", "Hypertension BP Screening", "HEDIS BPC / JPMC Wellness Rewards", ["wellness", "hypertension", "cardiovascular"],
    spec("Annual blood pressure screening for employees enrolled in the wellness program.", elig("All", "All Sites", "Wellness Program"),
      [{ label: "Medical Exemption", criteriaText: "Documented medical exemption on file" }], "Annual", ["Last BP screening date", "Program enrollment", "Exemption status"])),
  osha("diabetes_hba1c", "Diabetes HbA1c Monitoring", "HEDIS HBD / JPMC Wellness Rewards", ["wellness", "diabetes", "hba1c"],
    spec("Biannual HbA1c lab monitoring for employees enrolled in the diabetes management program.", elig("All", "All Sites", "Diabetes Management Program"),
      [{ label: "Medical Exemption", criteriaText: "Documented medical exemption on file" }], "Biannual (180 days)", ["Last HbA1c lab date", "Program enrollment", "Exemption status"])),
  osha("obesity_bmi", "BMI Screening & Counseling", "HEDIS WCC / Cigna Healthcare Wellness", ["wellness", "bmi", "obesity"],
    spec("Annual BMI screening and counseling for employees enrolled in the wellness program.", elig("All", "All Sites", "Wellness Program"),
      [{ label: "Medical Exemption", criteriaText: "Documented medical exemption on file" }], "Annual", ["Last BMI screening date", "Program enrollment", "Exemption status"])),
  osha("cholesterol_ldl", "Cholesterol LDL Screening", "HEDIS CBP / JPMC Wellness Rewards", ["wellness", "cholesterol", "cardiovascular"],
    spec("Annual LDL cholesterol lab screening for employees enrolled in the cardiovascular risk program.", elig("All", "All Sites", "Cholesterol Risk Program"),
      [{ label: "Medical Exemption", criteriaText: "Documented medical exemption on file" }], "Annual", ["Last LDL lab date", "Program enrollment", "Exemption status"])),
];

// Authored spec for the two Active CMS measures (override the generic catalog spec).
const CMS_ACTIVE_SPEC = {
  cms125: spec("Breast Cancer Screening (CMS125v14 / MIPS 112): women 50–74 who had a mammogram in the measurement period or 26 months prior.",
    elig("All", "All Sites", "Breast Cancer Screening Eligible"),
    [{ label: "Clinical Exclusion", criteriaText: "Bilateral mastectomy or history of breast cancer — documented exclusion on file" }],
    "27 months (820 days)", ["Last mammogram date", "Eligible population flag", "Exclusion status"]),
  cms122: spec("Diabetes: HbA1c Poor Control (CMS122v14 / MIPS 1): patients 18–75 with diabetes whose most recent HbA1c result is > 9% (poor control). OVERDUE indicates intervention is needed.",
    elig("All", "All Sites", "Diabetes Diagnosis"),
    [{ label: "Clinical Exclusion", criteriaText: "Hospice care, advanced illness, or other clinical exclusion" }],
    "Annual — based on HbA1c value, not recency", ["Most recent HbA1c lab value", "Diabetes diagnosis", "Exclusion status"]),
};
for (const c of cms) if (CMS_ACTIVE_SPEC[c.id]) c.spec = CMS_ACTIVE_SPEC[c.id];

// --- 3. OSHA catalog-only measures (V017__seed_additional_measures.sql) ----------
const catalogOnly = [
  { id: "respirator_fit_test", name: "Respirator Fit Test", policyRef: "OSHA 29 CFR 1910.134", version: "v0.9", status: "Draft", owner: "J. Chen", tags: ["surveillance", "respiratory", "osha"], compileStatus: "NOT_COMPILED",
    spec: spec("Annual medical evaluation and fit test for employees required to use respiratory protection under OSHA 1910.134.",
      elig("Maintenance Tech, Paint Crew, Chemical Handler", "Plant A, Plant B", "Enrolled in Respiratory Protection Program"),
      [{ label: "Medical Clearance Waiver", criteriaText: "Physician-issued respirator clearance waiver on file" }],
      "365 days from last fit test", ["Respirator Type", "Last Fit Test Date", "Medical Clearance Status"]) },
  { id: "hepatitis_b_vaccination_series", name: "Hepatitis B Vaccination Series", policyRef: "OSHA 29 CFR 1910.1030", version: "v2.0", status: "Approved", owner: "K. Williams", tags: ["vaccine", "bbp", "osha"], compileStatus: "COMPILED",
    spec: spec("Hepatitis B vaccination series completion for employees with occupational exposure to blood or other potentially infectious materials.",
      elig("Nurse, Lab Technician, Phlebotomist, Emergency Responder", "Clinic, Medical Center", "Bloodborne pathogen exposure risk role"),
      [{ label: "Documented Immunity", criteriaText: "Positive anti-HBs titer on file" }], "Series of 3 doses over 6 months", ["HBV Dose 1 Date", "HBV Dose 2 Date", "HBV Dose 3 Date", "Anti-HBs Titer Result"]) },
  { id: "lead_medical_surveillance", name: "Lead Medical Surveillance", policyRef: "OSHA 29 CFR 1910.1025", version: "v1.1", status: "Deprecated", owner: "M. Patel", tags: ["surveillance", "lead", "osha"], compileStatus: "COMPILED",
    spec: spec("DEPRECATED — Replaced by updated Lead Exposure Monitoring Protocol. Blood lead level monitoring for employees exposed to lead above the action level.",
      elig("Battery Plant Worker, Smelter, Lead Paint Handler", "Plant A", "Lead exposure above action level (30 µg/m³)"),
      [], "Every 6 months for blood lead monitoring", ["Blood Lead Level (µg/dL)", "Exam Date"]) },
];

const all = [...runnable, ...catalogOnly, ...cms];
if (all.length !== 60) throw new Error(`expected 60 catalog measures, built ${all.length}`);
if (new Set(all.map((m) => m.id)).size !== 60) throw new Error("duplicate measure id in the generated catalog");
if (all.some((m) => !m.spec)) throw new Error("a measure is missing its spec");

const body = all.map((m) => `  ${JSON.stringify(m)},`).join("\n");

const out = `/**
 * GENERATED by scripts/gen-measure-catalog.mjs — do not edit by hand.
 * The full 60-measure TWH catalog (summary + authoring spec) sourced from the Java seed
 * (MeasureService.CMS_ECQM_CATALOG + the OSHA/HEDIS seed + V017). The 10 Active measures are
 * exactly the engine's runnable set; \`cqlText\`/\`compileStatus\` are derived at request time
 * (reconstructed ELM for runnable measures). Lifecycle mutations need a persisted store (later).
 */
export type MeasureStatus = "Draft" | "Approved" | "Active" | "Deprecated";

export interface MeasureSpec {
  description: string;
  eligibilityCriteria: { roleFilter: string; siteFilter: string; programEnrollmentText: string };
  exclusions: Array<{ label: string; criteriaText: string }>;
  complianceWindow: string;
  requiredDataElements: string[];
}

export interface CatalogMeasure {
  id: string;
  name: string;
  policyRef: string;
  version: string;
  status: MeasureStatus;
  owner: string;
  tags: string[];
  /** Compile gate state: COMPILED (has working CQL) | NOT_COMPILED (catalog/Draft). */
  compileStatus: string;
  spec: MeasureSpec;
}

export const MEASURE_CATALOG: readonly CatalogMeasure[] = [
${body}
];
`;
writeFileSync(outFile, out);
console.log(`wrote ${outFile} (${all.length} measures: ${runnable.length} active runnable, ${catalogOnly.length} catalog-only, ${cms.length} CMS)`);
