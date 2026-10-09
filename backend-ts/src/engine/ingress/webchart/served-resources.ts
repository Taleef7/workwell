/**
 * What WebChart ingest puts into a patient's evaluation bundle: the one list the client fetches from
 * (`COMPOSED_RESOURCE_TYPES`) and the data-coverage report reads (#776), so the two cannot disagree.
 *
 * Adding a type here makes the client search for it on every patient: check that WebChart's
 * CapabilityStatement serves it first (`docs/WEBCHART_API_ASSUMPTIONS_2026-07.md`), because the client
 * treats a failed search as a failed patient.
 */
export interface ServedResource {
  readonly type: string;
  /** `population`: the patient list or a read by id; `fetched`: a per-patient search. */
  readonly how: "population" | "fetched";
  /** Anything ingest adds of this type from another resource (`normalize.ts`), or empty. */
  readonly derived: string;
}

export const WEBCHART_SERVED_RESOURCES: readonly ServedResource[] = [
  { type: "Patient", how: "population", derived: "" },
  {
    type: "Observation",
    how: "fetched",
    derived: "a LOINC 24606-6 imaging Observation from a CPT 77067/G0202 mammography Procedure",
  },
  { type: "Condition", how: "fetched", derived: "" },
  { type: "Procedure", how: "fetched", derived: "a Procedure from a final Observation coded as one, for authored measures" },
  { type: "Immunization", how: "fetched", derived: "" },
  { type: "Encounter", how: "fetched", derived: "" },
];
