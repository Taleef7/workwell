/**
 * WebChart → measure terminology reconciliation (E12 PR-2).
 *
 * WebChart clinical events arrive coded in REAL terminologies (LOINC labs/vitals, CVX vaccines,
 * CPT/HCPCS procedures). The WorkWell measures' CQL matches events by INLINE code filters on the
 * SYNTHETIC value sets the synthetic bundle builder stamps (`urn:workwell:vs:*`, see
 * `engine/synthetic/measure-bindings.ts`). This module bridges the two: given a real coding, it
 * yields the synthetic event coding the measure expects, so a real WebChart resource evaluates
 * against the unchanged measure.
 *
 * This is terminology **option B** (adapter-local crosswalk) from `docs/WEBCHART_FHIR_MAPPING.md` —
 * the demo-provable path. The standards-correct destination (option A/C: re-author measures to real
 * codes + a VSAC-backed `ValueSetResolver`) is deferred behind the E14 / VSAC unblock. The crosswalk
 * codes are representative (sample-not-prod; firm up with Dave Carlson's API + VSAC).
 *
 * Descriptive only (ADR-008/ADR-017): reconciliation never decides compliance — it only supplies the
 * coded FHIR the CQL engine then evaluates. The original real coding is PRESERVED (provenance); the
 * synthetic coding is ADDED alongside it so evidence keeps the real code.
 */
import { MEASURE_BINDINGS, type EventType } from "../../synthetic/measure-bindings.ts";

export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

/** Canonical code-system URIs (+ tolerated aliases) for the real terminologies WebChart uses. */
const SYSTEMS = {
  LOINC: "http://loinc.org",
  CVX: "http://hl7.org/fhir/sid/cvx",
  CPT: "http://www.ama-assn.org/go/cpt",
  HCPCS: "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
} as const;

// Real systems come from many sources with slightly different URIs/OIDs. Normalize leniently so a
// LOINC/CVX/CPT/HCPCS coding matches regardless of the exact URI a WebChart feed stamps.
const SYSTEM_ALIASES: Record<string, string> = {
  "http://loinc.org": SYSTEMS.LOINC,
  "https://loinc.org": SYSTEMS.LOINC,
  "urn:oid:2.16.840.1.113883.6.1": SYSTEMS.LOINC,
  loinc: SYSTEMS.LOINC,
  "http://hl7.org/fhir/sid/cvx": SYSTEMS.CVX,
  "https://hl7.org/fhir/sid/cvx": SYSTEMS.CVX,
  "urn:oid:2.16.840.1.113883.12.292": SYSTEMS.CVX,
  cvx: SYSTEMS.CVX,
  "http://www.ama-assn.org/go/cpt": SYSTEMS.CPT,
  "https://www.ama-assn.org/go/cpt": SYSTEMS.CPT,
  "urn:oid:2.16.840.1.113883.6.12": SYSTEMS.CPT,
  cpt: SYSTEMS.CPT,
  "http://www.cms.gov/medicare/coding/hcpcsreleasecodesets": SYSTEMS.HCPCS,
  "urn:oid:2.16.840.1.113883.6.285": SYSTEMS.HCPCS,
  hcpcs: SYSTEMS.HCPCS,
};

function normalizeSystem(system: string | undefined): string {
  if (!system) return "";
  const s = system.trim().toLowerCase();
  return SYSTEM_ALIASES[s] ?? system.trim();
}

/**
 * One WebChart-real code → the runnable measure whose event it satisfies. Grounded in the same real
 * standard codes as the E7 order catalog (`order/order-catalog.ts`), plus LOINC result codes for the
 * observation/lab measures (WebChart records those as observations, not orders). Add rows here as the
 * real WebChart code space is confirmed.
 */
interface CrosswalkRow {
  system: string;
  code: string;
  measureId: string;
}

const CROSSWALK_ROWS: CrosswalkRow[] = [
  // Procedures (CPT / HCPCS)
  { system: SYSTEMS.CPT, code: "92557", measureId: "audiogram" }, // comprehensive audiometry
  { system: SYSTEMS.CPT, code: "86580", measureId: "tb_surveillance" }, // TB intradermal skin test
  { system: SYSTEMS.CPT, code: "77067", measureId: "cms125" }, // screening mammography, bilateral (the active code)
  { system: SYSTEMS.HCPCS, code: "G0202", measureId: "cms125" }, // screening mammography — HCPCS G0202 was DELETED in 2018 (replaced by CPT 77067); matched on READ only for legacy dev-DB records
  // Vaccines (CVX) — codes verified Active against the CDC CVX code set (2026-07-08). The compliance-grade
  // groupings are VSAC value sets (Influenza Vaccine 2.16.840.1.113883.3.526.3.1254; MMR / Varicella /
  // Tdap groupings); resolve from those once the VSAC resolver is wired — until then these ARE the active
  // memberships. This is a real→synthetic READ map and emits nothing. A few INACTIVE codes are kept here
  // as read-only rows so legacy records still match: Td 139, Hep B 45, HCPCS G0202. Other inactive codes
  // (flu 88/15/16/144/151; Td 138; Hep B 220 PreHevbrio) are intentionally absent — neither matched nor emitted.
  // Influenza — was 141/140 only, which missed the high-dose / recombinant / adjuvanted / quadrivalent /
  // cell-based codes that make up the majority of real records. Full active seasonal set:
  ...["141", "140", "111", "135", "149", "150", "153", "155", "158", "168", "171", "185", "186", "197", "205", "231", "320", "333", "337"].map(
    (code): CrosswalkRow => ({ system: SYSTEMS.CVX, code, measureId: "flu_vaccine" }),
  ),
  // Td/Tdap (adult, HEDIS AIS-E) — Tdap 115 + the ACTIVE adult Td codes 09/113/196. 139 (Td unspecified)
  // is INACTIVE but kept as a read-only row so legacy Td records still match (it was previously the ONLY Td code — a real currency bug).
  ...["115", "09", "113", "196", "139"].map((code): CrosswalkRow => ({ system: SYSTEMS.CVX, code, measureId: "adult_immunization" })),
  { system: SYSTEMS.CVX, code: "03", measureId: "mmr" }, // MMR
  { system: SYSTEMS.CVX, code: "94", measureId: "mmr" }, // MMRV (confers measles+mumps+rubella+varicella)
  { system: SYSTEMS.CVX, code: "21", measureId: "varicella" }, // varicella
  { system: SYSTEMS.CVX, code: "94", measureId: "varicella" }, // MMRV also confers varicella immunity → counts toward the varicella series
  { system: SYSTEMS.CVX, code: "08", measureId: "hepatitis_b_vaccination_series" }, // Hep B, adolescent/pediatric
  { system: SYSTEMS.CVX, code: "43", measureId: "hepatitis_b_vaccination_series" }, // Hep B, adult
  { system: SYSTEMS.CVX, code: "44", measureId: "hepatitis_b_vaccination_series" }, // Hep B, dialysis
  { system: SYSTEMS.CVX, code: "45", measureId: "hepatitis_b_vaccination_series" }, // Hep B, unspecified — INACTIVE (read-only, legacy records)
  { system: SYSTEMS.CVX, code: "189", measureId: "hepatitis_b_vaccination_series" }, // Hep B (Heplisav-B)
  // Labs / vitals (LOINC) — WebChart records these as Observations (`observation_codes.loinc_num`).
  // Note the resource-type seam: `cms122` retrieves `[Observation]` (value-based), but the four
  // recency measures below retrieve `[Procedure]`. The normalizer handles this by synthesizing a dated
  // Procedure from a reconciled lab Observation (see `normalize.ts`), keyed on `targetEventType` here —
  // so a real WebChart LOINC lab drives BOTH the Observation- and Procedure-retrieving measures. The
  // standards-correct end state (re-point those measures to `[Observation]`) is option A (PR-2c / E14).
  { system: SYSTEMS.LOINC, code: "4548-4", measureId: "diabetes_hba1c" }, // HbA1c (recency, [Procedure])
  { system: SYSTEMS.LOINC, code: "4548-4", measureId: "cms122" }, // HbA1c (poor control > 9%, [Observation])
  { system: SYSTEMS.LOINC, code: "17856-6", measureId: "cms122" }, // HbA1c (POCT) alias
  { system: SYSTEMS.LOINC, code: "13457-7", measureId: "cholesterol_ldl" }, // LDL cholesterol (calc)
  { system: SYSTEMS.LOINC, code: "18262-6", measureId: "cholesterol_ldl" }, // LDL cholesterol (direct)
  { system: SYSTEMS.LOINC, code: "2089-1", measureId: "cholesterol_ldl" }, // LDL cholesterol (serum) — the code MIE's WebChart dev DB actually uses (#246)
  { system: SYSTEMS.LOINC, code: "85354-9", measureId: "hypertension" }, // BP panel
  { system: SYSTEMS.LOINC, code: "8480-6", measureId: "hypertension" }, // systolic BP — the BP component MIE's WebChart dev DB actually records (#246)
  { system: SYSTEMS.LOINC, code: "39156-5", measureId: "obesity_bmi" }, // BMI
];

/**
 * The synthetic event coding a measure's CQL matches (from the generated measure bindings), for the
 * given real code.
 *
 * Multi-alternative series (Hep B Heplisav-vs-traditional) are special: the CQL matches the SPECIFIC
 * alternative codes under the event value set (e.g. `urn:workwell:vs:hepb-vaccines` code `189`/`08`/…,
 * which the synthetic bundle builder stamps from `alt.codes`), NOT the generic `event.code`
 * (`hepb-vaccine`). Those synthetic codes ARE the real CVX numbers, so when the real code is one of the
 * alternative codes, preserve it verbatim — otherwise a real Heplisav-B/traditional dose would reconcile
 * to a code the CQL never matches and stay MISSING_DATA (Codex P2).
 */
function targetCodingFor(measureId: string, realCode: string): Coding | null {
  const b = MEASURE_BINDINGS[measureId];
  if (!b) return null;
  const altCodes = b.alternatives?.flatMap((a) => a.codes) ?? [];
  const code = altCodes.includes(realCode) ? realCode : b.event.code;
  return { system: b.event.valueSet, code, display: code };
}

// Lookup keyed by `${normalizedSystem}|${code}` (code upper-cased so HCPCS letters match). One real
// code can satisfy MORE THAN ONE measure — e.g. LOINC 4548-4 (HbA1c) drives both `diabetes_hba1c` and
// `cms122` — so the value is a LIST of synthetic target codings, not a single one.
const CROSSWALK = new Map<string, Coding[]>();
// A synthetic target coding → the retrieve type of the measure that owns it (`procedure` targets from a
// source Observation are synthesized into a Procedure by the normalizer). Keyed `${valueSet}|${code}`.
const TARGET_EVENT_TYPE = new Map<string, EventType>();
for (const row of CROSSWALK_ROWS) {
  const binding = MEASURE_BINDINGS[row.measureId];
  const target = targetCodingFor(row.measureId, row.code);
  if (!binding || !target) continue; // a crosswalk row for an unknown/removed measure is a no-op, never a throw
  const key = `${normalizeSystem(row.system)}|${row.code.toUpperCase()}`;
  const list = CROSSWALK.get(key) ?? [];
  if (!list.some((t) => t.system === target.system && t.code === target.code)) list.push(target);
  CROSSWALK.set(key, list);
  TARGET_EVENT_TYPE.set(`${target.system}|${target.code}`, binding.event.type);
}

/** The retrieve type (`procedure` | `immunization` | `observation`) of the measure a synthetic target
 * coding belongs to, or null if it isn't a known target — lets the normalizer decide resource synthesis. */
export function targetEventType(coding: Coding): EventType | null {
  return TARGET_EVENT_TYPE.get(`${coding.system}|${coding.code}`) ?? null;
}

/**
 * Map one real WebChart coding to the synthetic measure-event coding(s) it satisfies — a list, since a
 * code can serve several measures. Empty when it isn't a code the measures care about (most WebChart
 * codings — the vast dictionary — are irrelevant and pass through untouched).
 */
export function reconcileCoding(coding: Coding | undefined): Coding[] {
  if (!coding?.code) return [];
  const key = `${normalizeSystem(coding.system)}|${coding.code.trim().toUpperCase()}`;
  return CROSSWALK.get(key) ?? [];
}

/**
 * Given a resource's coding array (from `code.coding` or `vaccineCode.coding`), return a NEW array
 * with any reconciled synthetic codings appended (deduped). The originals are preserved for
 * provenance. Returns the same array reference when nothing reconciles (cheap no-op for the common case).
 */
export function reconcileCodings(codings: Coding[] | undefined): Coding[] {
  if (!codings?.length) return codings ?? [];
  const additions: Coding[] = [];
  const seen = new Set(codings.map((c) => `${c.system}|${c.code}`));
  for (const c of codings) {
    for (const target of reconcileCoding(c)) {
      const k = `${target.system}|${target.code}`;
      if (!seen.has(k)) {
        seen.add(k);
        additions.push(target);
      }
    }
  }
  return additions.length ? [...codings, ...additions] : codings;
}

/** Diagnostic: the measures a crosswalk currently covers (for the mapping report + tests). */
export function crosswalkMeasureIds(): string[] {
  return [...new Set(CROSSWALK_ROWS.map((r) => r.measureId))].sort();
}

/**
 * Every CVX code this crosswalk recognizes for a measure — the repo's single source of truth for
 * "which vaccine codes count toward this series" (active codes plus the read-only inactive ones kept
 * for legacy records). Consumed by the ICE forecaster (ADR-029) so its dose counting recognizes the
 * same real-world codes the WebChart read path does, rather than the one representative code the
 * synthetic history happens to emit.
 */
export function cvxCodesForMeasure(measureId: string): string[] {
  return CROSSWALK_ROWS.filter((r) => r.system === SYSTEMS.CVX && r.measureId === measureId).map((r) => r.code);
}
