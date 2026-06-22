/**
 * Demo value-set + terminology seed (#108 value-set governance) — port of
 * ValueSetGovernanceService.ensureDemoValueSets + the V013 demo terminology rows.
 *
 * INVARIANT: each value set's `name` MUST match the `valueset "<name>":` declaration in its
 * measure's CQL — resolveCheck flags a CQL valueset whose name isn't among the attached sets as
 * an unattached-reference blocker. (The wellness names here are aligned to the CQL, which fixes a
 * latent mismatch in the Java seed's longer display names.)
 *
 * Seeds the 22 demo value sets (the 4 OSHA procedure sets the CQL matches by name, their
 * enrollment/waiver sets, and the wellness sets) with stable ids that mirror the Java UUIDs,
 * then links each to its measure's latest version. Links are keyed by measure SLUG (the TS
 * measure id) → its floor version id, resolved by the caller. Idempotent: seedValueSet upserts
 * by id and link() is ON CONFLICT DO NOTHING, so re-running on boot is safe.
 */
import type { CodeEntry, CreateTerminologyMappingInput, ValueSetStore } from "../stores/value-set-store.ts";

const c = (code: string, display: string, system: string): CodeEntry => ({ code, display, system });
const CPT = "http://www.ama-assn.org/go/cpt";
const CVX = "http://hl7.org/fhir/sid/cvx";
const DEMO = "urn:workwell:demo";
const VER = "2025-demo";

interface SeedVs {
  id: string;
  oid: string;
  name: string;
  codes: CodeEntry[];
}

const VALUE_SETS: SeedVs[] = [
  // 4 OSHA procedure sets (CQL matches these by name)
  { id: "a0000001-0000-0000-0000-000000000001", oid: "urn:workwell:vs:audiogram-procedures", name: "Audiogram Procedures", codes: [
    c("LOCAL-AUD-001", "Baseline audiogram", DEMO),
    c("LOCAL-AUD-002", "Annual audiogram evaluation", DEMO),
    c("LOCAL-AUD-003", "Audiometric test pure tone", DEMO),
    c("audiogram-procedure", "Audiogram procedure", "urn:workwell:vs:audiogram-procedures"),
    c("92557", "Comprehensive audiometry evaluation", CPT),
  ] },
  { id: "a0000001-0000-0000-0000-000000000002", oid: "urn:workwell:vs:tb-screening", name: "TB Screening Procedures", codes: [
    c("LOCAL-TB-001", "PPD skin test placement", DEMO),
    c("LOCAL-TB-002", "TB IGRA blood test", DEMO),
    c("tb-screen", "TB Screening Procedures", "urn:workwell:vs:tb-screening"),
    c("86580", "Intradermal skin test", CPT),
  ] },
  { id: "a0000001-0000-0000-0000-000000000003", oid: "urn:workwell:vs:hazwoper-exams", name: "HAZWOPER Surveillance Exams", codes: [
    c("LOCAL-HAZ-001", "HAZWOPER medical surveillance exam", DEMO),
    c("LOCAL-HAZ-002", "Annual fitness-for-duty evaluation", DEMO),
    c("hazwoper-exam", "HAZWOPER Surveillance Exams", "urn:workwell:vs:hazwoper-exams"),
  ] },
  { id: "a0000001-0000-0000-0000-000000000004", oid: "urn:workwell:vs:flu-vaccines", name: "Influenza Vaccines", codes: [
    c("88", "Influenza virus vaccine unspecified", CVX),
    c("141", "Influenza seasonal injectable", CVX),
    c("flu-vaccine", "Influenza Vaccines", "urn:workwell:vs:flu-vaccines"),
    c("LOCAL-FLU-001", "Flu vaccine administered", DEMO),
  ] },
  // enrollment / waiver sets
  { id: "a0000001-0000-0000-0000-000000000005", oid: "urn:workwell:vs:hearing-enrollment", name: "Hearing Conservation Enrollment", codes: [c("hearing-enrollment", "Hearing Conservation Enrollment", "urn:workwell:vs:hearing-enrollment")] },
  { id: "a0000001-0000-0000-0000-000000000006", oid: "urn:workwell:vs:audiogram-waiver", name: "Audiogram Medical Waiver", codes: [c("audiogram-waiver", "Audiogram Medical Waiver", "urn:workwell:vs:audiogram-waiver")] },
  { id: "a0000001-0000-0000-0000-000000000007", oid: "urn:workwell:vs:tb-eligible-roles", name: "TB Eligible Roles", codes: [c("tb-program", "TB Eligible Roles", "urn:workwell:vs:tb-eligible-roles")] },
  { id: "a0000001-0000-0000-0000-000000000008", oid: "urn:workwell:vs:tb-exemption", name: "TB Medical Exemption", codes: [c("tb-exemption", "TB Medical Exemption", "urn:workwell:vs:tb-exemption")] },
  { id: "a0000001-0000-0000-0000-000000000009", oid: "urn:workwell:vs:hazwoper-enrollment", name: "HAZWOPER Program Enrollment", codes: [c("hazwoper-program", "HAZWOPER Program Enrollment", "urn:workwell:vs:hazwoper-enrollment")] },
  { id: "a0000001-0000-0000-0000-000000000010", oid: "urn:workwell:vs:hazwoper-exemption", name: "HAZWOPER Medical Exemption", codes: [c("hazwoper-exemption", "HAZWOPER Medical Exemption", "urn:workwell:vs:hazwoper-exemption")] },
  { id: "a0000001-0000-0000-0000-000000000011", oid: "urn:workwell:vs:clinical-roles", name: "Clinical Facing Roles", codes: [c("clinical-role", "Clinical Facing Roles", "urn:workwell:vs:clinical-roles")] },
  { id: "a0000001-0000-0000-0000-000000000012", oid: "urn:workwell:vs:flu-exemption", name: "Flu Vaccine Exemption", codes: [c("flu-exemption", "Flu Vaccine Exemption", "urn:workwell:vs:flu-exemption")] },
  // wellness sets
  { id: "b0000001-0000-0000-0000-000000000001", oid: "urn:workwell:vs:wellness-enrollment", name: "Wellness Program Enrollment", codes: [c("wellness-enrolled", "Wellness Program Enrollment", "urn:workwell:vs:wellness-enrollment")] },
  { id: "b0000001-0000-0000-0000-000000000002", oid: "urn:workwell:vs:wellness-exemption", name: "Wellness Exemption", codes: [c("wellness-exempt", "Wellness Exemption", "urn:workwell:vs:wellness-exemption")] },
  { id: "b0000001-0000-0000-0000-000000000003", oid: "urn:workwell:vs:bp-screening", name: "BP Screening Procedures", codes: [
    c("bp-screen", "Blood Pressure Screening", "urn:workwell:vs:bp-screening"),
    c("99213", "Office visit established patient", CPT),
  ] },
  { id: "b0000001-0000-0000-0000-000000000004", oid: "urn:workwell:vs:diabetes-program", name: "Diabetes Program Enrollment", codes: [c("diabetes-enrolled", "Diabetes Program Enrollment", "urn:workwell:vs:diabetes-program")] },
  { id: "b0000001-0000-0000-0000-000000000005", oid: "urn:workwell:vs:diabetes-exemption", name: "Diabetes Program Exemption", codes: [c("diabetes-exempt", "Diabetes Program Exemption", "urn:workwell:vs:diabetes-exemption")] },
  { id: "b0000001-0000-0000-0000-000000000006", oid: "urn:workwell:vs:hba1c-labs", name: "HbA1c Lab Procedures", codes: [
    c("hba1c-lab", "HbA1c Lab", "urn:workwell:vs:hba1c-labs"),
    c("83036", "Glycosylated hemoglobin test", CPT),
  ] },
  { id: "b0000001-0000-0000-0000-000000000007", oid: "urn:workwell:vs:bmi-screening", name: "BMI Screening Procedures", codes: [
    c("bmi-screen", "BMI Screening", "urn:workwell:vs:bmi-screening"),
    c("99401", "Preventive medicine counseling", CPT),
  ] },
  { id: "b0000001-0000-0000-0000-000000000008", oid: "urn:workwell:vs:cholesterol-program", name: "Cholesterol Program Enrollment", codes: [c("cholesterol-enrolled", "Cholesterol Program Enrollment", "urn:workwell:vs:cholesterol-program")] },
  { id: "b0000001-0000-0000-0000-000000000009", oid: "urn:workwell:vs:cholesterol-exemption", name: "Cholesterol Program Exemption", codes: [c("cholesterol-exempt", "Cholesterol Program Exemption", "urn:workwell:vs:cholesterol-exemption")] },
  { id: "b0000001-0000-0000-0000-000000000010", oid: "urn:workwell:vs:ldl-labs", name: "LDL Lab Procedures", codes: [
    c("ldl-lab", "LDL Cholesterol Lab", "urn:workwell:vs:ldl-labs"),
    c("83721", "LDL cholesterol direct measurement", CPT),
  ] },
  // immunization shared enrollment + MMR sets (E10.6)
  { id: "c0000001-0000-0000-0000-000000000001", oid: "urn:workwell:vs:immz-enrollment", name: "Immunization Program Enrollment", codes: [c("immz-enrolled", "Immunization Program Enrollment", "urn:workwell:vs:immz-enrollment")] },
  { id: "c0000001-0000-0000-0000-000000000002", oid: "urn:workwell:vs:mmr-vaccines", name: "MMR Vaccines", codes: [
    c("mmr-vaccine", "MMR Vaccines", "urn:workwell:vs:mmr-vaccines"),
    c("03", "MMR", CVX),
    c("94", "MMRV", CVX),
  ] },
  { id: "c0000001-0000-0000-0000-000000000003", oid: "urn:workwell:vs:mmr-contraindication", name: "MMR Contraindication", codes: [c("mmr-contraindication", "MMR Contraindication", "urn:workwell:vs:mmr-contraindication")] },
  { id: "c0000001-0000-0000-0000-000000000004", oid: "urn:workwell:vs:mmr-refusal", name: "MMR Refusal", codes: [c("mmr-refusal", "MMR Refusal", "urn:workwell:vs:mmr-refusal")] },
  // Varicella sets (E10.6 Task 4)
  { id: "c0000001-0000-0000-0000-000000000005", oid: "urn:workwell:vs:varicella-vaccines", name: "Varicella Vaccines", codes: [
    c("varicella-vaccine", "Varicella Vaccines", "urn:workwell:vs:varicella-vaccines"),
    c("21", "Varicella", CVX),
  ] },
  { id: "c0000001-0000-0000-0000-000000000006", oid: "urn:workwell:vs:varicella-contraindication", name: "Varicella Contraindication", codes: [c("varicella-contraindication", "Varicella Contraindication", "urn:workwell:vs:varicella-contraindication")] },
  { id: "c0000001-0000-0000-0000-000000000007", oid: "urn:workwell:vs:varicella-refusal", name: "Varicella Refusal", codes: [c("varicella-refusal", "Varicella Refusal", "urn:workwell:vs:varicella-refusal")] },
];

/** measure slug → the value-set ids attached to it (Java's ensureLink table, keyed by slug). */
const LINKS: Record<string, string[]> = {
  audiogram: ["a0000001-0000-0000-0000-000000000001", "a0000001-0000-0000-0000-000000000005", "a0000001-0000-0000-0000-000000000006"],
  tb_surveillance: ["a0000001-0000-0000-0000-000000000002", "a0000001-0000-0000-0000-000000000007", "a0000001-0000-0000-0000-000000000008"],
  hazwoper: ["a0000001-0000-0000-0000-000000000003", "a0000001-0000-0000-0000-000000000009", "a0000001-0000-0000-0000-000000000010"],
  flu_vaccine: ["a0000001-0000-0000-0000-000000000004", "a0000001-0000-0000-0000-000000000011", "a0000001-0000-0000-0000-000000000012"],
  hypertension: ["b0000001-0000-0000-0000-000000000003", "b0000001-0000-0000-0000-000000000001", "b0000001-0000-0000-0000-000000000002"],
  diabetes_hba1c: ["b0000001-0000-0000-0000-000000000006", "b0000001-0000-0000-0000-000000000004", "b0000001-0000-0000-0000-000000000005"],
  obesity_bmi: ["b0000001-0000-0000-0000-000000000007", "b0000001-0000-0000-0000-000000000001", "b0000001-0000-0000-0000-000000000002"],
  cholesterol_ldl: ["b0000001-0000-0000-0000-000000000010", "b0000001-0000-0000-0000-000000000008", "b0000001-0000-0000-0000-000000000009"],
  mmr: ["c0000001-0000-0000-0000-000000000002", "c0000001-0000-0000-0000-000000000001", "c0000001-0000-0000-0000-000000000003", "c0000001-0000-0000-0000-000000000004"],
  varicella: ["c0000001-0000-0000-0000-000000000005", "c0000001-0000-0000-0000-000000000001", "c0000001-0000-0000-0000-000000000006", "c0000001-0000-0000-0000-000000000007"],
};

/** The 5 demo terminology mappings from V013 (fixed ids so re-seed is idempotent by UNIQUE key). */
const TERMINOLOGY: CreateTerminologyMappingInput[] = [
  { id: "a0000002-0000-0000-0000-000000000001", localCode: "LOCAL-AUD-002", localDisplay: "Annual audiogram evaluation", localSystem: DEMO, standardCode: "92557", standardDisplay: "Comprehensive audiometry evaluation", standardSystem: CPT, mappingStatus: "APPROVED", mappingConfidence: 0.98, notes: null },
  { id: "a0000002-0000-0000-0000-000000000002", localCode: "LOCAL-TB-001", localDisplay: "PPD skin test placement", localSystem: DEMO, standardCode: "86580", standardDisplay: "Intradermal skin test", standardSystem: CPT, mappingStatus: "APPROVED", mappingConfidence: 0.95, notes: null },
  { id: "a0000002-0000-0000-0000-000000000003", localCode: "LOCAL-FLU-001", localDisplay: "Flu vaccine administered", localSystem: DEMO, standardCode: "141", standardDisplay: "Influenza seasonal injectable", standardSystem: CVX, mappingStatus: "APPROVED", mappingConfidence: 0.97, notes: null },
  { id: "a0000002-0000-0000-0000-000000000004", localCode: "LOCAL-HAZ-001", localDisplay: "HAZWOPER medical surveillance exam", localSystem: DEMO, standardCode: "hazwoper-exam", standardDisplay: "HAZWOPER Surveillance Exams", standardSystem: "urn:workwell:vs:hazwoper-exams", mappingStatus: "REVIEWED", mappingConfidence: 0.8, notes: "Internal code; no public standard." },
  { id: "a0000002-0000-0000-0000-000000000005", localCode: "LOCAL-TB-002", localDisplay: "TB IGRA blood test", localSystem: DEMO, standardCode: "86480", standardDisplay: "Tuberculosis test, cell-mediated immunity", standardSystem: CPT, mappingStatus: "PROPOSED", mappingConfidence: 0.7, notes: "Awaiting review." },
];

/**
 * Seed the demo value sets + links + terminology mappings. `versionIdOf(slug)` resolves a
 * measure slug to its latest floor version id (links target the version, not the measure).
 * Slugs with no seeded measure are skipped (their links get created on a later boot).
 */
export async function seedValueSets(store: ValueSetStore, versionIdOf: (measureSlug: string) => string | undefined): Promise<void> {
  for (const vs of VALUE_SETS) {
    await store.seedValueSet({ id: vs.id, oid: vs.oid, name: vs.name, version: VER, codes: vs.codes });
  }
  for (const [slug, valueSetIds] of Object.entries(LINKS)) {
    const versionId = versionIdOf(slug);
    if (!versionId) continue;
    for (const vsId of valueSetIds) await store.link(versionId, vsId);
  }
  for (const tm of TERMINOLOGY) {
    try {
      await store.createTerminologyMapping(tm);
    } catch {
      // UNIQUE(local_system, local_code, standard_system, standard_code) — already seeded; ignore.
    }
  }
}
