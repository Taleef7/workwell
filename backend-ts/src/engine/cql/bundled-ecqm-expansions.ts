/**
 * Committed minimal VSAC expansions for production eCQM measures (CMS122v14 / CMS125v14, 2026).
 *
 * Offline-safe: the run pipeline and tests evaluate eCQI-aligned CQL without a live VSAC key.
 * Codes are representative members of the official OID (enough for dual-coded synthetic paths).
 * Owner can still run `pnpm resolve-valuesets` for full expansions; non-empty store results win.
 */
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";

const SNOMED = "http://snomed.info/sct";
const LOINC = "http://loinc.org";
const CPT = "http://www.ama-assn.org/go/cpt";
const HCPCS = "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets";

/** Representative codes dual-stamped on synthetic resources. */
export const ECQM_CANONICAL_CODES = {
  diabetes: { code: "44054006", system: SNOMED, display: "Type 2 diabetes mellitus" },
  hba1c: { code: "4548-4", system: LOINC, display: "Hemoglobin A1c/Hemoglobin.total in Blood" },
  gmi: { code: "97506-0", system: LOINC, display: "Glucose management indicator" },
  officeVisit: { code: "99213", system: CPT, display: "Office visit" },
  awv: { code: "G0438", system: HCPCS, display: "Annual wellness visit" },
  hospiceEncounter: { code: "385763009", system: SNOMED, display: "Hospice care" },
  hospiceDx: { code: "170935008", system: SNOMED, display: "Full care by hospice" },
  palliativeDx: { code: "103735009", system: SNOMED, display: "Palliative care" },
  palliativeEnc: { code: "305284002", system: SNOMED, display: "Admission by palliative care physician" },
  palliativeProc: { code: "103735009", system: SNOMED, display: "Palliative care" },
  mammogram: { code: "77067", system: CPT, display: "Screening mammography bilateral" },
  bilateralMastectomy: { code: "428338009", system: SNOMED, display: "Bilateral mastectomy" },
  historyBilateralMastectomy: { code: "428338009", system: SNOMED, display: "History of bilateral mastectomy" },
  leftMastectomy: { code: "428529004", system: SNOMED, display: "Left mastectomy" },
  rightMastectomy: { code: "429400009", system: SNOMED, display: "Right mastectomy" },
  virtualEnc: { code: "99421", system: CPT, display: "Online digital E/M" },
} as const;

const code = (c: { code: string; system: string }): CqlCode => ({ code: c.code, system: c.system });

const map: Record<string, CqlCode[]> = {
  // CMS122
  "2.16.840.1.113883.3.464.1003.103.12.1001": [code(ECQM_CANONICAL_CODES.diabetes)],
  "2.16.840.1.113883.3.464.1003.198.12.1013": [code(ECQM_CANONICAL_CODES.hba1c)],
  "2.16.840.1.113883.3.464.1003.101.12.1001": [code(ECQM_CANONICAL_CODES.officeVisit)],
  "2.16.840.1.113883.3.526.3.1240": [code(ECQM_CANONICAL_CODES.awv)],
  "2.16.840.1.113883.3.464.1003.101.12.1025": [code(ECQM_CANONICAL_CODES.officeVisit)],
  "2.16.840.1.113883.3.464.1003.101.12.1023": [code(ECQM_CANONICAL_CODES.officeVisit)],
  "2.16.840.1.113883.3.464.1003.101.12.1016": [{ code: "99341", system: CPT }],
  "2.16.840.1.113883.3.464.1003.101.12.1080": [{ code: "99441", system: CPT }],
  "2.16.840.1.113883.3.464.1003.1006": [{ code: "97802", system: CPT }],
  "2.16.840.1.113883.3.464.1003.1003": [code(ECQM_CANONICAL_CODES.hospiceEncounter)],
  "2.16.840.1.113883.3.526.3.1584": [code(ECQM_CANONICAL_CODES.hospiceEncounter)],
  "2.16.840.1.113883.3.464.1003.1165": [code(ECQM_CANONICAL_CODES.hospiceDx)],
  "2.16.840.1.113883.3.464.1003.1167": [code(ECQM_CANONICAL_CODES.palliativeDx)],
  "2.16.840.1.113883.3.464.1003.101.12.1090": [code(ECQM_CANONICAL_CODES.palliativeEnc)],
  "2.16.840.1.113883.3.464.1003.198.12.1135": [code(ECQM_CANONICAL_CODES.palliativeProc)],
  // CMS125
  "2.16.840.1.113883.3.464.1003.108.12.1018": [code(ECQM_CANONICAL_CODES.mammogram)],
  "2.16.840.1.113883.3.464.1003.101.12.1089": [code(ECQM_CANONICAL_CODES.virtualEnc)],
  "2.16.840.1.113883.3.464.1003.198.12.1068": [code(ECQM_CANONICAL_CODES.historyBilateralMastectomy)],
  "2.16.840.1.113883.3.464.1003.198.12.1005": [code(ECQM_CANONICAL_CODES.bilateralMastectomy)],
  "2.16.840.1.113883.3.464.1003.198.12.1069": [code(ECQM_CANONICAL_CODES.leftMastectomy)],
  "2.16.840.1.113883.3.464.1003.198.12.1070": [code(ECQM_CANONICAL_CODES.rightMastectomy)],
  "2.16.840.1.113883.3.464.1003.198.12.1133": [code(ECQM_CANONICAL_CODES.leftMastectomy)],
  "2.16.840.1.113883.3.464.1003.198.12.1134": [code(ECQM_CANONICAL_CODES.rightMastectomy)],
};

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
