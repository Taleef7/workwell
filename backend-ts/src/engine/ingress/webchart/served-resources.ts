/**
 * What WebChart ingest puts into a patient's evaluation bundle: the one list the client fetches from
 * (`COMPOSED_RESOURCE_TYPES`) and the data-coverage report reads (#776), so the two cannot disagree.
 *
 * Adding a type here makes the client search for it on every patient: check that WebChart's
 * CapabilityStatement serves it first (`docs/WEBCHART_API_ASSUMPTIONS_2026-07.md`), and count the call:
 * each type is one more search per patient against the API's daily cap.
 */
export interface ServedResource {
  readonly type: string;
  /** `population`: the patient list or a read by id; `fetched`: a per-patient search. */
  readonly how: "population" | "fetched";
  /**
   * A server that answers 404 to this type's search before it has ever answered one this run (it does not
   * support the type) skips it for the run, with one warning in the log and the run's record, instead of
   * failing every patient: the measures then read none of it, which is where they stood before it was
   * composed (#713). Once the type has answered, a 404 is a failed search like any other. A type that is
   * not optional keeps the strict rule: any failed search degrades the whole patient, because partial
   * clinical data must never evaluate.
   */
  readonly optional: boolean;
  /** Anything ingest adds of this type from another resource (`normalize.ts`), or empty. */
  readonly derived: string;
  /** What is known about the data WebChart sends for it that limits what a measure can count, or empty. */
  readonly caveat: string;
}

export const WEBCHART_SERVED_RESOURCES: readonly ServedResource[] = [
  { type: "Patient", how: "population", optional: false, derived: "", caveat: "" },
  {
    type: "Observation",
    how: "fetched",
    optional: false,
    derived: "a LOINC 24606-6 imaging Observation from a CPT 77067/G0202 mammography Procedure",
    caveat: "",
  },
  { type: "Condition", how: "fetched", optional: false, derived: "", caveat: "" },
  {
    type: "Procedure",
    how: "fetched",
    optional: false,
    derived: "a Procedure from a final Observation coded as one, for authored measures",
    caveat: "",
  },
  { type: "Immunization", how: "fetched", optional: false, derived: "", caveat: "" },
  { type: "Encounter", how: "fetched", optional: false, derived: "", caveat: "" },
  // #713. Each was in WebChart's CapabilityStatement with search by patient, and answered 200 for every
  // patient on the trial instance (2026-10-09).
  {
    type: "MedicationRequest",
    how: "fetched",
    optional: true,
    derived: "",
    caveat:
      "WebChart's trial codes every medication in FDDC (http://terminology.hl7.org/CodeSystem/FDDC), never RxNorm, which the CMS medication value sets match (checked 2026-10-09).",
  },
  {
    type: "ServiceRequest",
    how: "fetched",
    optional: true,
    derived: "",
    caveat: "125 of 134 orders on WebChart's trial carry no code, so no order value set can match them (checked 2026-10-09).",
  },
  {
    type: "Coverage",
    how: "fetched",
    optional: true,
    derived: "",
    caveat: "WebChart's trial has it for 2 of 36 patients, with no Coverage.type (checked 2026-10-09).",
  },
];
