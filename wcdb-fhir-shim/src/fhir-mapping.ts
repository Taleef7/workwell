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

/**
 * US Core's `us-core-sex`, emitted ALONGSIDE `Patient.gender` from the same `patients.sex` column.
 *
 * CMS125's official initial population compares this extension's value against SNOMED `248152002` and
 * never consults `gender`. With the extension absent, every subject failed that conjunct and the whole
 * roster fell out of the population — measured over the committed dev-DB fixture: 4 actionable subjects
 * → 0 (`devdb-official-eval.test.ts`).
 *
 * **What justifies emitting both, stated carefully.** These are two different FHIR elements, and it would
 * be convenient to say WebChart's column is "recorded sex" rather than administrative gender — but
 * `docs/WEBCHART_FHIR_MAPPING.md` §3.1 calls `patients.sex` the `administrative-gender` source, and a
 * single F/M column does not settle the question either way. So the defensible rule is narrower than a
 * semantic claim about the column: **we assert `us-core-sex` where the source system records a sex value,
 * and we decline to synthesize it from a FHIR `gender` we did not map ourselves.** That is why
 * `normalizeWebChartBundle` does not stamp it for third-party WebChart FHIR servers (ADR-042 decision 2):
 * there the value would be inferred from someone else's mapping, not read from a source column.
 *
 * A row whose `sex` is neither F nor M gets neither element — so such a patient stays out of official
 * CMS125's population. Fail closed: reading nobody beats guessing.
 *
 * The SNOMED code is load-bearing: the ELM compares against the concept id, so an extension carrying
 * `"F"` is indistinguishable from one that is absent.
 *
 * **Drift coverage, accurately.** The file header names `hapi-live.test.ts` bucket parity as the guard for
 * this duplication; that guard cannot see THIS field. It compares authored-engine bucket counts, and the
 * authored engine reads `Patient.gender` and never the extension — which is precisely how both mapping
 * sites came to omit it. What actually covers it: `server.test.ts` pins this function's output (present
 * with the right code; absent when the column names neither sex), and `devdb-official-eval.test.ts` pins
 * the export script's committed output. Nothing cross-checks the two sites against each other.
 */
const US_CORE_SEX_URL = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex";
const SNOMED_SEX: Record<"F" | "M", string> = { F: "248152002", M: "248153007" };

/** The `us-core-sex` extension array for a WCDB `sex` value, or nothing when it names neither sex. */
export function usCoreSexExtension(sex: string | undefined): Array<{ url: string; valueCode: string }> | undefined {
  if (sex !== "F" && sex !== "M") return undefined;
  return [{ url: US_CORE_SEX_URL, valueCode: SNOMED_SEX[sex] }];
}

export const subjectIdFor = (patId: number | string): string => `wc-${patId}`;

/** Inverse of `subjectIdFor`: "wc-5" → 5. Returns undefined for anything else. */
export function patIdFromSubjectId(subjectId: string): number | undefined {
  const m = /^wc-(\d+)$/.exec(subjectId);
  return m ? Number(m[1]) : undefined;
}

export function patientToFhir(row: PatientRow): FhirResource {
  const subjectId = subjectIdFor(row.pat_id);
  const sex = str(row.sex);
  const sexExtension = usCoreSexExtension(sex);
  return {
    resourceType: "Patient",
    id: subjectId,
    name: [{ text: [str(row.first_name), str(row.last_name)].filter(Boolean).join(" ") || subjectId }],
    ...(sex === "F" ? { gender: "female" } : sex === "M" ? { gender: "male" } : {}),
    ...(sexExtension ? { extension: sexExtension } : {}),
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
