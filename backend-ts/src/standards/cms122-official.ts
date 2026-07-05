/**
 * E14 PR-3 — the official-subset CMS122 measure as an inline engine meta, kept OUT of the MEASURES
 * registry (which seed:scale / quality backfill / segment+order tests iterate — must not be polluted).
 * The library id matches the CQL header in measures/cms122_official.cql. Value sets are the official
 * VSAC OIDs (resolved from the imported value_sets rows by StoreValueSetResolver). Descriptive only.
 */
import type { MeasureMeta } from "../engine/cql/measure-registry.ts";

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
