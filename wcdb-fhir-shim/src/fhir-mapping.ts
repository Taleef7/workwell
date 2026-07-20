/**
 * fhir-mapping.ts — WCDB rows → FHIR R4 resources.
 *
 * The shapes are deliberately kept in lock-step with the committed-fixture generator
 * `backend-ts/scripts/webchart-devdb-export.ts` (a ~100-line intentional duplication — no
 * cross-package import; the `hapi-live.test.ts` bucket-parity suite is the drift guard):
 * date-only FHIR dateTimes, `wc-{pat_id}` subject ids, LOINC/CPT/HCPCS system URIs the
 * backend crosswalk recognizes, and final/completed event statuses so the normalizer's
 * status gate keeps them.
 *
 * One shim-specific addition: every clinical resource gets a DETERMINISTIC minted id
 * (`{patientId}-{type}-{ordinal}`, the `load:hapi` transform's scheme) because the WebChart
 * client dedupes composed entries by `type/id` — id-less resources would collapse.
 */
import type { ObservationRow, PatientRow, ProcedureRow } from "./db.ts";

export const SYS = {
  LOINC: "http://loinc.org",
  CPT: "http://www.ama-assn.org/go/cpt",
  HCPCS: "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
} as const;

export type FhirResource = Record<string, unknown> & { resourceType: string; id?: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const fhirDate = (v: unknown): string | undefined => {
  const s = str(v);
  return s && !/^0{4}-0{2}-0{2}/.test(s) ? s : undefined;
};
export const cptSystem = (cpt: string): string => (/^\d{5}$/.test(cpt) ? SYS.CPT : SYS.HCPCS);

export const subjectIdFor = (patId: number | string): string => `wc-${patId}`;

/** Inverse of `subjectIdFor`: "wc-5" → 5. Returns undefined for anything else. */
export function patIdFromSubjectId(subjectId: string): number | undefined {
  const m = /^wc-(\d+)$/.exec(subjectId);
  return m ? Number(m[1]) : undefined;
}

export function patientToFhir(row: PatientRow): FhirResource {
  const subjectId = subjectIdFor(row.pat_id);
  const sex = str(row.sex);
  return {
    resourceType: "Patient",
    id: subjectId,
    name: [{ text: [str(row.first_name), str(row.last_name)].filter(Boolean).join(" ") || subjectId }],
    ...(sex === "F" ? { gender: "female" } : sex === "M" ? { gender: "male" } : {}),
    ...(fhirDate(row.birth_date) ? { birthDate: fhirDate(row.birth_date) } : {}),
  };
}

export function observationToFhir(row: ObservationRow, ordinal: number): FhirResource {
  const subjectId = subjectIdFor(row.pat_id);
  return {
    resourceType: "Observation",
    id: `${subjectId}-Observation-${ordinal}`,
    status: "final",
    subject: { reference: `Patient/${subjectId}` },
    code: { coding: [{ system: SYS.LOINC, code: row.loinc, ...(str(row.name) ? { display: str(row.name) } : {}) }] },
    ...(fhirDate(row.dt) ? { effectiveDateTime: fhirDate(row.dt) } : {}),
    ...(row.value != null ? { valueQuantity: { value: Number(row.value) } } : {}),
  };
}

export function procedureToFhir(row: ProcedureRow, ordinal: number): FhirResource {
  const subjectId = subjectIdFor(row.pat_id);
  return {
    resourceType: "Procedure",
    id: `${subjectId}-Procedure-${ordinal}`,
    status: "completed",
    subject: { reference: `Patient/${subjectId}` },
    code: { coding: [{ system: cptSystem(row.cpt), code: row.cpt }] },
    ...(fhirDate(row.dt) ? { performedDateTime: fhirDate(row.dt) } : {}),
  };
}

/** A FHIR searchset Bundle whose entries are all `search.mode: "match"`. `total` = FULL match count (not page size). */
export function searchsetBundle(
  resources: FhirResource[],
  opts: { total?: number; nextUrl?: string } = {},
): Record<string, unknown> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: opts.total ?? resources.length,
    link: opts.nextUrl ? [{ relation: "next", url: opts.nextUrl }] : [],
    entry: resources.map((resource) => ({ resource, search: { mode: "match" } })),
  };
}

/** Minimal R4 CapabilityStatement — enough for the live-test availability probe (`GET /fhir/metadata`). */
export function capabilityStatement(): Record<string, unknown> {
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: "2026-07-20",
    kind: "instance",
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    software: { name: "wcdb-fhir-shim" },
    implementation: { description: "Dev/demo FHIR facade over the WebChart dev database (ADR-034)" },
    rest: [
      {
        mode: "server",
        resource: ["Patient", "Observation", "Condition", "Procedure", "Immunization", "Encounter"].map(
          (type) => ({ type, interaction: [{ code: "search-type" }] }),
        ),
      },
    ],
  };
}
