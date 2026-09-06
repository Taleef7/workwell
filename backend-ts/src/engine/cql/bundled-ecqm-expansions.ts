/**
 * The codes the synthetic corpus stamps for the production eCQM measures, and the offline expansion of
 * the value sets those measures reference.
 *
 * Offline-safe: the run pipeline and tests evaluate eCQI-aligned CQL without a live VSAC key. The owner
 * can still run `pnpm resolve-valuesets` for full expansions; non-empty store results win.
 *
 * ## Every code here is a verified MEMBER of the official artifact's own expansion
 *
 * That property is what makes the corpus answerable by the measure CMS actually publishes, and it is
 * enforced by `wiring/corpus-membership.test.ts` rather than trusted. It did not hold before: an audit of this
 * file against the vendored CMS122/CMS125 terminology found **12 of 24 codes were not members of the set
 * they were registered under** — and because this file supplies BOTH the code stamped on the synthetic
 * resource AND the offline expansion the authored CQL resolves, the two agreed with each other and the
 * authored measures passed. They were internally consistent and externally wrong, which is the only shape
 * of this bug that survives a test suite.
 *
 * The consequence was measured, not theorised: the official CMS122 artifact scored the synthetic EXCLUDED
 * cohort as COMPLIANT, because SNOMED 103735009 is a member of "Palliative Care Intervention" but not of
 * "Palliative Care Diagnosis", so the denominator exclusion never fired. CMS125 was worse — every subject
 * fell out of the initial population entirely.
 *
 * ## Why several concepts appear twice under different names
 *
 * `hospiceEncounter` and `hospiceCareAmbulatory` are the same clinical idea and DIFFERENT codes, because
 * VSAC's "Hospice Encounter" and "Hospice Care Ambulatory" do not share members. One constant serving two
 * value sets is precisely how the old file went wrong: 385763009 is a member of the second and not the
 * first, so whichever set it was written for, the other silently matched nothing. Same story for the four
 * mastectomy sets. The names are ugly on purpose — they name a value set, not a concept.
 */
import type { CqlCode, ValueSetResolver } from "@work-well/measure-engine";

const SNOMED = "http://snomed.info/sct";
const LOINC = "http://loinc.org";
const CPT = "http://www.ama-assn.org/go/cpt";
const HCPCS = "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
/** Source of Payment Typology — the system of every member of the "Payer Type" value set. */
const SOPT = "https://nahdo.org/sopt";
/** CDC Race and Ethnicity code system, as the `us-core-race` / `us-core-ethnicity` extensions carry it. */
const CDC_RACE_ETHNICITY = "urn:oid:2.16.840.1.113883.6.238";

/**
 * Representative codes dual-stamped on synthetic resources.
 *
 * `display` is present only where the term is known to be the code's actual meaning. It is never matched
 * on — FHIR resolves a coding by system+code — so an invented display would be a false clinical label
 * bought for nothing, and the same rule that keeps `qicore-preparation.ts` from inventing an onset date
 * applies here.
 */
export const ECQM_CANONICAL_CODES = {
  diabetes: { code: "44054006", system: SNOMED, display: "Type 2 diabetes mellitus" },
  hba1c: { code: "4548-4", system: LOINC, display: "Hemoglobin A1c/Hemoglobin.total in Blood" },
  /** Not a value-set member — the official numerator retrieves this LOINC code directly. */
  gmi: { code: "97506-0", system: LOINC, display: "Glucose management indicator" },
  officeVisit: { code: "99213", system: CPT, display: "Office visit, established patient" },
  preventiveEstablished: { code: "99395", system: CPT },
  preventiveInitial: { code: "99385", system: CPT },
  homeHealth: { code: "99341", system: CPT },
  telephoneVisit: { code: "185317003", system: SNOMED },
  nutritionServices: { code: "97802", system: CPT },
  awv: { code: "G0438", system: HCPCS, display: "Annual wellness visit" },
  virtualEnc: { code: "99421", system: CPT, display: "Online digital E/M" },
  hospiceEncounter: { code: "183919006", system: SNOMED },
  hospiceCareAmbulatory: { code: "385763009", system: SNOMED },
  hospiceDx: { code: "170935008", system: SNOMED },
  palliativeDx: { code: "441874000", system: SNOMED },
  palliativeEnc: { code: "305284002", system: SNOMED },
  palliativeProc: { code: "103735009", system: SNOMED },
  /**
   * LOINC, and an Observation — not CPT on a Procedure. The official CMS125 numerator is
   * `[Observation: "Mammography"]`, and every one of that value set's 92 members is LOINC. The corpus
   * still emits the CPT Procedure too (see `MAMMOGRAPHY_PROCEDURE_CODES`); a real EHR records both.
   */
  mammogram: { code: "24606-6", system: LOINC, display: "MG Breast Screening" },
  historyBilateralMastectomy: { code: "136071000119101", system: SNOMED },
  bilateralMastectomy: { code: "1268980002", system: SNOMED },
  statusPostLeftMastectomy: { code: "429009003", system: SNOMED },
  statusPostRightMastectomy: { code: "429242008", system: SNOMED },
  unilateralMastectomyLeft: { code: "428571003", system: SNOMED },
  unilateralMastectomyRight: { code: "429400009", system: SNOMED },

  // ── cms2 / cms130 / cms165 (Task 3) ─────────────────────────────────────────────
  // Direct-reference codes from the ELM's codes.def — they have no value set.
  depressionScreenAdult: { code: "73832-8", system: LOINC, display: "Adult depression screening assessment" },
  depressionScreenAdolescent: { code: "73831-0", system: LOINC, display: "Adolescent depression screening assessment" },
  depressionScreenNegative: { code: "428171000124102", system: SNOMED, display: "Depression screening negative" },
  depressionScreenPositive: { code: "428181000124104", system: SNOMED, display: "Depression screening positive" },
  /**
   * The follow-up ORDER for a positive screen — a member of `Referral for Adult Depression`
   * (2.16.840.1.113883.3.526.3.1571), and confirmed against CMS's own CMS2 deck, which uses exactly
   * this code on a ServiceRequest.
   *
   * The corpus used `depressionScreenPositive` here, which is a FINDING: it classifies the screening
   * result and is a direct-reference code with no value set. A finding is not an orderable service, so
   * CMS2's numerator — whose follow-up paths are the referral, follow-up and antidepressant value
   * sets — retrieved nothing, and every screened-positive patient with a documented follow-up read as
   * non-compliant. Measured at 20,000: 1,240 follow-up orders, none of them retrievable.
   */
  depressionFollowUpReferral: { code: "183524004", system: SNOMED, display: "Referral to psychiatry service" },
  bpPanel: { code: "85354-9", system: LOINC, display: "Blood pressure panel" },
  bpSystolic: { code: "8480-6", system: LOINC, display: "Systolic blood pressure" },
  bpDiastolic: { code: "8462-4", system: LOINC, display: "Diastolic blood pressure" },
  // Value-set members from the ELM's valueSets.def.
  // 13746004, NOT 13746000. The latter is not a valid SCTID at all (its Verhoeff check digit fails)
  // and `tx.fhir.org $lookup` returns not-found for it in both the international and US editions, so
  // it can be a member of no expansion: CMS2's bipolar DENOMINATOR EXCLUSION never fired and every
  // excluded patient was counted in the denominator AND the numerator. Verified 2026-09-05:
  // $lookup(13746004) returns "Bipolar disorder".
  bipolarDisorder: { code: "13746004", system: SNOMED, display: "Bipolar disorder" },
  // 73761001 "Colonoscopy", NOT 44441009 — which `tx.fhir.org $lookup` resolves to "Flexible
  // fiberoptic sigmoidoscopy (procedure)". It was registered under the Colonoscopy value set with a
  // display of "Colonoscopy", so it was both in the wrong value set and carrying a false clinical
  // label (which the rule at the top of this file forbids). CMS130 gives colonoscopy a NINE-year
  // lookback and flexible sigmoidoscopy four, so a real colonoscopy 5-9 years old read as OVERDUE.
  // The synthetic COMPLIANT case passed only because 3 years is inside both windows.
  // Verified 2026-09-05: $lookup(73761001) returns "Colonoscopy".
  colonoscopy: { code: "73761001", system: SNOMED, display: "Colonoscopy" },
  // The corpus generates a colorectal screening mix, and FOBT is the second modality whose membership
  // is established (the artifact retrieves five; see COLORECTAL_MODALITIES for why only two are
  // emitted). Display verified 2026-09-05 against tx.fhir.org $lookup, which returns
  // "Hemoglobin [Presence] in Stool from gastrointestinal" — used verbatim rather than a friendlier
  // paraphrase, per the display rule at the top of this file.
  fobt: { code: "2335-8", system: LOINC, display: "Hemoglobin [Presence] in Stool from gastrointestinal" },

  // ── cms137 (MIPS 305, SUD initiation and engagement) ────────────────────────────────────────────
  // Members taken from the artifact's OWN vendored expansion, not chosen from a browser: the corpus
  // only has to stamp something the measure retrieves, and the value set is the authority on what that
  // is. Displays verified 2026-09-06 against tx.fhir.org $lookup.
  /**
   * The SUD episode diagnosis. ALCOHOL, not cocaine: CMS's own CMS137 deck is dominated by alcohol
   * abuse, which matches US primary-care epidemiology, and the corpus previously gave all 564 of its
   * SUD patients "Cocaine-induced mood disorder" — mechanically retrievable, and not a panel any
   * physician recognises. The second diagnosis lives in `SUD_CONDITION_CODES` below, because the
   * canonical table is one code per value set by construction.
   */
  sudCondition: { code: "7200002", system: SNOMED, display: "Alcohol abuse" },
  sudTreatment: { code: "171047005", system: SNOMED, display: "Drugs of addiction education" },
  colorectalCancer: { code: "363406005", system: SNOMED, display: "Malignant tumor of colon" },
  essentialHypertension: { code: "59621000", system: SNOMED, display: "Essential hypertension" },
  esrd: { code: "46177005", system: SNOMED, display: "End stage renal disease" },

  // ── the denominator EXCLUSIONS the ACO's measures share (AIFrailLTCF, PalliativeCare) ──────────
  // Each is a member of the value set named in CANONICAL_CODE_VALUE_SETS, read off the CMS-published
  // expansions in the vendored bundles (2026-09-06) — and checked against the sidecar by
  // `corpus-membership.test.ts`, which is the gate, not this comment. Displays are the expansions' own.
  /** "Frailty Diagnosis" — the Condition half of `Has Criteria Indicating Frailty`. */
  frailtyDx: { code: "129588001", system: SNOMED, display: "Adult failure to thrive syndrome" },
  /** "Advanced Illness" — a diagnosis whose onset in the year before or during the period, with frailty, excludes a 66+ patient. */
  advancedIllness: { code: "42343007", system: SNOMED, display: "Congestive heart failure" },
  /** "Dementia Medications" — the medication alternative to an advanced-illness diagnosis in the same exclusion. */
  dementiaMedication: { code: "1100184", system: RXNORM, display: "donepezil hydrochloride 23 MG Oral Tablet" },
  /** "Total Colectomy" — cms130's surgical exclusion. */
  totalColectomy: { code: "26390003", system: SNOMED, display: "Total colectomy" },

  // ── the supplemental data elements every vendored artifact declares (SDE Payer / Race / Ethnicity) ─
  /** "Payer Type" — the canonical member; the rest of the mix lives in PAYER_TYPE_CODES. */
  payerMedicare: { code: "1", system: SOPT, display: "MEDICARE" },
  /** "Race" — the canonical member; the rest of the mix lives in RACE_CODES. */
  raceWhite: { code: "2106-3", system: CDC_RACE_ETHNICITY, display: "White" },
  /** "Ethnicity" — the canonical member; the other member lives in ETHNICITY_CODES. */
  ethnicityNotHispanic: { code: "2186-5", system: CDC_RACE_ETHNICITY, display: "Not Hispanic or Latino" },
} as const;

/**
 * Which official value set each canonical code must belong to — the contract `wiring/corpus-membership.test.ts`
 * checks. Exported so the test reads the same table the expansion is built from; a test with its own copy
 * of this mapping would pass while the expansion below used a different one.
 *
 * `gmi`, `depressionScreenAdult`, `depressionScreenAdolescent`, `depressionScreenNegative`,
 * `depressionScreenPositive`, `bpPanel`, `bpSystolic`, and `bpDiastolic` are absent deliberately:
 * the official artifacts retrieve these as direct code references, so there is no value set for
 * them to be a member of.
 */
export const CANONICAL_CODE_VALUE_SETS: Record<
  Exclude<
    keyof typeof ECQM_CANONICAL_CODES,
    // The eight the comment above names: retrieved by direct code reference, so no value set
    // exists for them to be a member of. The type must list them all, or it demands entries the
    // table deliberately does not have.
    | "gmi"
    | "depressionScreenAdult"
    | "depressionScreenAdolescent"
    | "depressionScreenNegative"
    | "depressionScreenPositive"
    | "bpPanel"
    | "bpSystolic"
    | "bpDiastolic"
  >,
  string
> = {
  depressionFollowUpReferral: "2.16.840.1.113883.3.526.3.1571",
  diabetes: "2.16.840.1.113883.3.464.1003.103.12.1001",
  hba1c: "2.16.840.1.113883.3.464.1003.198.12.1013",
  officeVisit: "2.16.840.1.113883.3.464.1003.101.12.1001",
  preventiveEstablished: "2.16.840.1.113883.3.464.1003.101.12.1025",
  preventiveInitial: "2.16.840.1.113883.3.464.1003.101.12.1023",
  homeHealth: "2.16.840.1.113883.3.464.1003.101.12.1016",
  telephoneVisit: "2.16.840.1.113883.3.464.1003.101.12.1080",
  nutritionServices: "2.16.840.1.113883.3.464.1003.1006",
  awv: "2.16.840.1.113883.3.526.3.1240",
  virtualEnc: "2.16.840.1.113883.3.464.1003.101.12.1089",
  hospiceEncounter: "2.16.840.1.113883.3.464.1003.1003",
  hospiceCareAmbulatory: "2.16.840.1.113883.3.526.3.1584",
  hospiceDx: "2.16.840.1.113883.3.464.1003.1165",
  palliativeDx: "2.16.840.1.113883.3.464.1003.1167",
  palliativeEnc: "2.16.840.1.113883.3.464.1003.101.12.1090",
  palliativeProc: "2.16.840.1.113883.3.464.1003.198.12.1135",
  mammogram: "2.16.840.1.113883.3.464.1003.108.12.1018",
  historyBilateralMastectomy: "2.16.840.1.113883.3.464.1003.198.12.1068",
  bilateralMastectomy: "2.16.840.1.113883.3.464.1003.198.12.1005",
  statusPostLeftMastectomy: "2.16.840.1.113883.3.464.1003.198.12.1069",
  statusPostRightMastectomy: "2.16.840.1.113883.3.464.1003.198.12.1070",
  unilateralMastectomyLeft: "2.16.840.1.113883.3.464.1003.198.12.1133",
  unilateralMastectomyRight: "2.16.840.1.113883.3.464.1003.198.12.1134",
  bipolarDisorder: "2.16.840.1.113883.3.67.1.101.1.128",
  colonoscopy: "2.16.840.1.113883.3.464.1003.108.12.1020",
  // "Fecal Occult Blood Test (FOBT)", read off cms130/bundle.json's own ELM valueSets.def.
  fobt: "2.16.840.1.113883.3.464.1003.198.12.1011",
  // Read off cms137/bundle.json's own ELM valueSets.def.
  sudCondition: "2.16.840.1.113883.3.464.1003.106.12.1001",
  sudTreatment: "2.16.840.1.113883.3.464.1003.106.12.1005",
  colorectalCancer: "2.16.840.1.113883.3.464.1003.108.12.1001",
  essentialHypertension: "2.16.840.1.113883.3.464.1003.104.12.1011",
  esrd: "2.16.840.1.113883.3.526.3.353",
  // Read off the AdvancedIllnessandFrailty library's valueSets.def (shared by cms122/125/130/165).
  frailtyDx: "2.16.840.1.113883.3.464.1003.113.12.1074",
  advancedIllness: "2.16.840.1.113883.3.464.1003.110.12.1082",
  dementiaMedication: "2.16.840.1.113883.3.464.1003.196.12.1510",
  // Read off cms130/bundle.json's own ELM valueSets.def.
  totalColectomy: "2.16.840.1.113883.3.464.1003.198.12.1019",
  // The SupplementalDataElements library's three value sets, declared by every vendored artifact.
  payerMedicare: "2.16.840.1.114222.4.11.3591",
  raceWhite: "2.16.840.1.114222.4.11.836",
  ethnicityNotHispanic: "2.16.840.1.114222.4.11.837",
};

/**
 * The payer, race and ethnicity codes the corpus draws from — each array's members belong to ONE value
 * set, and the canonical table above holds one representative per set by construction (that
 * one-code-per-set rule is a real guard, see `corpus-membership.test.ts`). The rest of each mix lives
 * here and is folded into the offline expansion below, the way `SUD_CONDITION_CODES` is.
 */
export const PAYER_TYPE_CODES: CqlCode[] = [
  { code: "1", system: SOPT },   // MEDICARE
  { code: "11", system: SOPT },  // Medicare Managed Care (Medicare Advantage)
  { code: "2", system: SOPT },   // MEDICAID
  { code: "5", system: SOPT },   // PRIVATE HEALTH INSURANCE
];
export const RACE_CODES: CqlCode[] = [
  { code: "2106-3", system: CDC_RACE_ETHNICITY }, // White
  { code: "2028-9", system: CDC_RACE_ETHNICITY }, // Asian
  { code: "2076-8", system: CDC_RACE_ETHNICITY }, // Native Hawaiian or Other Pacific Islander
  { code: "2131-1", system: CDC_RACE_ETHNICITY }, // Other Race
  { code: "2054-5", system: CDC_RACE_ETHNICITY }, // Black or African American
  { code: "1002-5", system: CDC_RACE_ETHNICITY }, // American Indian or Alaska Native
];
export const ETHNICITY_CODES: CqlCode[] = [
  { code: "2186-5", system: CDC_RACE_ETHNICITY }, // Not Hispanic or Latino
  { code: "2135-2", system: CDC_RACE_ETHNICITY }, // Hispanic or Latino
];

/**
 * The `us-core-sex` extension's values — SNOMED, as bare `valueCode`s rather than codings, which is how
 * US Core defines the extension and how CMS125's initial population reads it (`= '248152002'`). Not
 * value-set members and not in the canonical table: there is no value set, the artifact compares the
 * literal.
 */
export const US_CORE_SEX_CODES = { F: "248152002", M: "248153007" } as const;

/**
 * The active CPT a screening mammogram carries as a PROCEDURE — what the corpus stamps, what WebChart
 * records, and what the authored `cms125` retrieves.
 *
 * Not a member of VSAC's Mammography value set: that set is the Observation-flavoured LOINC one, all 92
 * members. So it lives outside `ECQM_CANONICAL_CODES` and outside the membership contract, deliberately.
 */
export const MAMMOGRAPHY_PROCEDURE_CPT: CqlCode = { code: "77067", system: CPT };

/** Deleted in 2018, replaced by CPT 77067. Matched on READ for legacy dev-DB rows; never stamped. */
const MAMMOGRAPHY_PROCEDURE_LEGACY_HCPCS: CqlCode = { code: "G0202", system: HCPCS };

/**
 * The SUD diagnoses the corpus draws from, both members of the same Substance Use Disorder value set.
 * A second entry in `ECQM_CANONICAL_CODES` would break that table's one-code-per-value-set invariant —
 * which is a real guard, not a formality — so the variety lives here and is folded into the offline
 * expansion the same way the mammography procedure codes are.
 */
export const SUD_CONDITION_CODES: CqlCode[] = [
  { code: "7200002", system: SNOMED },
  { code: "10327003", system: SNOMED },
];

/** Both procedure-side codes, for the offline expansion the authored `cms125` resolves. */
export const MAMMOGRAPHY_PROCEDURE_CODES: CqlCode[] = [
  MAMMOGRAPHY_PROCEDURE_CPT,
  MAMMOGRAPHY_PROCEDURE_LEGACY_HCPCS,
];

const code = (c: { code: string; system: string }): CqlCode => ({ code: c.code, system: c.system });

const map: Record<string, CqlCode[]> = Object.fromEntries(
  Object.entries(CANONICAL_CODE_VALUE_SETS).map(([key, oid]) => [
    oid,
    [code(ECQM_CANONICAL_CODES[key as keyof typeof CANONICAL_CODE_VALUE_SETS])],
  ]),
);
// The authored cms125 resolves this same OID and retrieves a Procedure, so the offline expansion has to
// admit the procedure codes as well as the canonical LOINC one.
map[CANONICAL_CODE_VALUE_SETS.mammogram]!.push(...MAMMOGRAPHY_PROCEDURE_CODES);
map[CANONICAL_CODE_VALUE_SETS.sudCondition]!.push(...SUD_CONDITION_CODES);
// The mixes: each array's first member is the canonical one already in the map, so dedupe on the way in.
for (const [oid, codes] of [
  [CANONICAL_CODE_VALUE_SETS.payerMedicare, PAYER_TYPE_CODES],
  [CANONICAL_CODE_VALUE_SETS.raceWhite, RACE_CODES],
  [CANONICAL_CODE_VALUE_SETS.ethnicityNotHispanic, ETHNICITY_CODES],
] as const) {
  const known = new Set(map[oid]!.map((c) => `${c.system}|${c.code}`));
  for (const c of codes) if (!known.has(`${c.system}|${c.code}`)) map[oid]!.push(c);
}

/** Always-available resolver for committed eCQM OID expansions. */
export const bundledEcqmValueSetResolver: ValueSetResolver = {
  expand(valueSetUrl: string): Promise<CqlCode[]> {
    const bare = valueSetUrl.replace(/^urn:oid:/, "");
    return Promise.resolve(map[bare] ?? map[valueSetUrl] ?? []);
  },
};

/** Prefer primary (store/VSAC) when non-empty; else bundled offline expansions. */
export function withBundledEcqmFallback(primary?: ValueSetResolver): ValueSetResolver {
  if (!primary) return bundledEcqmValueSetResolver;
  return {
    async expand(valueSetUrl: string): Promise<CqlCode[]> {
      const fromPrimary = await primary.expand(valueSetUrl);
      if (fromPrimary.length > 0) return fromPrimary;
      return bundledEcqmValueSetResolver.expand(valueSetUrl);
    },
  };
}
