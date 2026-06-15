/**
 * OSHA reference lookup (#107 Studio authoring) — the curated `osha_references` seed, ported as a
 * static list (the Java table is a fixed seed: migration V0xx + ON CONFLICT DO NOTHING). Drives the
 * Studio Spec tab's policy-reference combobox via GET /api/osha-references.
 *
 * Ids are deterministic so the list is stable across restarts (the Java rows are random UUIDs, but
 * the frontend only reads citation/title/programArea — the id is an opaque selection key).
 */
export interface OshaReference {
  id: string;
  cfrCitation: string;
  title: string;
  programArea: string;
}

const ROWS: ReadonlyArray<Omit<OshaReference, "id">> = [
  { cfrCitation: "29 CFR 1904", title: "Recording and Reporting Occupational Injuries and Illnesses", programArea: "Recordkeeping" },
  { cfrCitation: "29 CFR 1910.95", title: "Occupational Noise Exposure", programArea: "Hearing Conservation" },
  { cfrCitation: "29 CFR 1910.120", title: "Hazardous Waste Operations and Emergency Response", programArea: "Hazardous Materials" },
  { cfrCitation: "29 CFR 1910.134", title: "Respiratory Protection", programArea: "Respiratory Protection" },
  { cfrCitation: "29 CFR 1910.269", title: "Electric Power Generation, Transmission, and Distribution", programArea: "Utility Operations" },
  { cfrCitation: "29 CFR 1910.1020", title: "Access to Employee Exposure and Medical Records", programArea: "Medical Records" },
  { cfrCitation: "29 CFR 1910.1030", title: "Bloodborne Pathogens", programArea: "Infection Control" },
  { cfrCitation: "29 CFR 1910.1096", title: "Ionizing Radiation", programArea: "Radiation Safety" },
];

/** Stable, deterministic id from the citation (the Java FK is opaque to the frontend). */
const idFor = (citation: string): string => `osha-${citation.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;

/** The catalog, ordered by citation then title (matches the Java ORDER BY). */
export const OSHA_REFERENCES: ReadonlyArray<OshaReference> = ROWS.map((r) => ({ id: idFor(r.cfrCitation), ...r })).sort(
  (a, b) => (a.cfrCitation === b.cfrCitation ? a.title.localeCompare(b.title) : a.cfrCitation.localeCompare(b.cfrCitation)),
);

export function listOshaReferences(): OshaReference[] {
  return OSHA_REFERENCES.map((r) => ({ ...r }));
}
