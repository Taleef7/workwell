/**
 * E14 PR-3 — the official-subset CMS122 measure as an inline engine meta, kept OUT of the MEASURES
 * registry (which seed:scale / quality backfill / segment+order tests iterate — must not be polluted).
 * The library id matches the CQL header in measures/cms122_official.cql. Value sets are the official
 * VSAC OIDs (resolved from the imported value_sets rows by StoreValueSetResolver). Descriptive only.
 */
import type { MeasureMeta } from "../engine/cql/measure-registry.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import type { CqlCode } from "../engine/cql/value-set-resolver.ts";

/** OID probed to decide real-execution vs the PR-2 estimate (Diabetes value set). */
export const CMS122_DIABETES_OID = "2.16.840.1.113883.3.464.1003.103.12.1001";
export const CMS122_HBA1C_OID = "2.16.840.1.113883.3.464.1003.198.12.1013";
export const CMS122_QUALIFYING_VISIT_OIDS = [
  "2.16.840.1.113883.3.464.1003.101.12.1001",
  "2.16.840.1.113883.3.526.3.1240",
  "2.16.840.1.113883.3.464.1003.101.12.1025",
  "2.16.840.1.113883.3.464.1003.101.12.1023",
  "2.16.840.1.113883.3.464.1003.101.12.1016",
  "2.16.840.1.113883.3.464.1003.101.12.1080",
  "2.16.840.1.113883.3.464.1003.1006",
];
export const CMS122_HOSPICE_OID = "2.16.840.1.113883.3.464.1003.1003";
export const CMS122_PALLIATIVE_OID = "2.16.840.1.113883.3.464.1003.1167";

/** Inline meta for the official-subset measure (never registered in MEASURES). */
export const CMS122_OFFICIAL_META: MeasureMeta = {
  id: "cms122_official",
  name: "CMS122v14 Official-Subset (Diagnostic)",
  library: "DiabetesHbA1cPoorControlOfficialCQL-1.0.0",
  expansionLibrary: "DiabetesHbA1cPoorControlOfficialCQL-1.0.0",
  valueSets: [
    CMS122_DIABETES_OID,
    CMS122_HBA1C_OID,
    ...CMS122_QUALIFYING_VISIT_OIDS,
    CMS122_HOSPICE_OID,
    CMS122_PALLIATIVE_OID,
  ],
  periodMonths: 12,
};

export type Expansions = Map<string, CqlCode[]>;

/** Stable per-subject hash → deterministic gate assignment (visit/age/exclusion divergence subsets). */
function hash(externalId: string): number {
  let h = 0;
  for (const ch of externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const first = (ex: Expansions, oid: string): CqlCode | null => ex.get(oid)?.[0] ?? null;

const isType = (r: { resourceType?: string }, t: string) => r.resourceType === t;

/** anchorDate is "YYYY-MM-DD"; returns the FHIR dateTime `daysAgo` before it (mirrors fhir-bundle-builder). */
function dateMinusDays(anchorDate: string, daysAgo: number): string {
  const d = new Date(`${anchorDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.toISOString().slice(0, 10)}T00:00:00`;
}

/**
 * Additively enrich a subject's synthetic bundle so the official-subset CMS122 gates fire. Real
 * VSAC-member codings sampled from `expansions` (the same sets the official measure resolves) are
 * APPENDED — never replacing existing `urn:workwell:*` codings — so WorkWell's cms122 outcome is
 * unchanged (ADR-008 guard test). The sole in-place field override is `Patient.birthDate` (age-out),
 * safe because WorkWell's cms122 CQL ignores age. `anchorDate` (YYYY-MM-DD, the run's eval date) anchors
 * the qualifying-visit + hospice Encounter periods so they fall WITHIN the measurement period
 * ([anchor−12mo, anchor]) by construction — the official CQL now period-filters those retrieves, so a
 * hardcoded/stale Encounter date would otherwise drop out and understate official eligibility (Codex P2).
 * Deterministic per externalId. Mutates + returns `bundle`.
 */
export function enrichForOfficialCms122(bundle: FhirBundle, employee: EmployeeProfile, expansions: Expansions, anchorDate: string): FhirBundle {
  const h = hash(employee.externalId);
  const entries = bundle.entry as Array<{ resource: Record<string, unknown> }>;

  // 1) Append the VSAC diabetes coding onto the existing diabetes Condition (urn:workwell code preserved).
  const diabetesCode = first(expansions, CMS122_DIABETES_OID);
  if (diabetesCode) {
    for (const e of entries) {
      const r = e.resource as { resourceType?: string; code?: { coding?: CqlCode[] } };
      if (isType(r, "Condition") && r.code?.coding?.some((c) => c.system === "urn:workwell:vs:cms122-diabetes")) {
        r.code.coding!.push({ ...diabetesCode });
      }
    }
  }
  // 2) Append the VSAC HbA1c coding onto the existing HbA1c Observation.
  const hba1cCode = first(expansions, CMS122_HBA1C_OID);
  if (hba1cCode) {
    for (const e of entries) {
      const r = e.resource as { resourceType?: string; code?: { coding?: CqlCode[] } };
      if (isType(r, "Observation") && r.code?.coding?.some((c) => c.system === "urn:workwell:vs:cms122-hba1c")) {
        r.code.coding!.push({ ...hba1cCode });
      }
    }
  }
  // 3) Qualifying visit: most subjects get one; a deterministic ~1/6 get NONE → age/visit divergence.
  const visitCode = first(expansions, CMS122_QUALIFYING_VISIT_OIDS[0]!);
  if (visitCode && h % 6 !== 0) {
    const visitDay = dateMinusDays(anchorDate, 90); // ~90d before anchor → inside [anchor−12mo, anchor]
    entries.push({ resource: {
      resourceType: "Encounter", id: `${employee.externalId}-enc-visit`, status: "finished",
      subject: { reference: `Patient/${employee.externalId}` },
      type: [{ coding: [{ ...visitCode }] }],
      period: { start: visitDay, end: visitDay },
    } });
  }
  // 4) Age-out a deterministic ~1/10 (birthDate override is outcome-neutral for WorkWell → ADR-008 safe).
  if (h % 10 === 0) {
    const patient = entries.find((e) => (e.resource as { resourceType?: string }).resourceType === "Patient");
    if (patient) (patient.resource as { birthDate?: string }).birthDate = "1944-01-01";
  }
  // 5) Hospice exclusion for a deterministic ~1/12; palliative for a different ~1/12.
  const hospiceCode = first(expansions, CMS122_HOSPICE_OID);
  if (hospiceCode && h % 12 === 1) {
    const hospiceDay = dateMinusDays(anchorDate, 120); // ~120d before anchor → inside the measurement period
    entries.push({ resource: {
      resourceType: "Encounter", id: `${employee.externalId}-enc-hospice`, status: "finished",
      subject: { reference: `Patient/${employee.externalId}` },
      type: [{ coding: [{ ...hospiceCode }] }],
      period: { start: hospiceDay, end: hospiceDay },
    } });
  }
  const palliativeCode = first(expansions, CMS122_PALLIATIVE_OID);
  if (palliativeCode && h % 12 === 2) {
    entries.push({ resource: {
      resourceType: "Condition", id: `${employee.externalId}-cond-palliative`,
      subject: { reference: `Patient/${employee.externalId}` },
      code: { coding: [{ ...palliativeCode }] },
    } });
  }
  return bundle;
}
