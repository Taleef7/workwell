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
 * enforced by `official-membership.test.ts` rather than trusted. It did not hold before: an audit of this
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
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";

const SNOMED = "http://snomed.info/sct";
const LOINC = "http://loinc.org";
const CPT = "http://www.ama-assn.org/go/cpt";
const HCPCS = "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets";

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
} as const;

/**
 * Which official value set each canonical code must belong to — the contract `official-membership.test.ts`
 * checks. Exported so the test reads the same table the expansion is built from; a test with its own copy
 * of this mapping would pass while the expansion below used a different one.
 *
 * `gmi` is absent deliberately: the official numerator retrieves LOINC 97506-0 as a direct code reference,
 * so there is no value set for it to be a member of.
 */
export const CANONICAL_CODE_VALUE_SETS: Record<Exclude<keyof typeof ECQM_CANONICAL_CODES, "gmi">, string> = {
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
};

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
