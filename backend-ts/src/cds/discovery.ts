/**
 * The CDS Hooks service catalog (ADR-067) — what `GET /cds-services` advertises.
 *
 * ## One service, and why
 *
 * `patient-view` only. In the separately versioned CDS Hooks Library IG (v1.0.1, 2025-03-12) it carries
 * maturity **5** — the level every CDS client implements — while `encounter-start`, the other hook that
 * fits an in-encounter quality check, is at maturity **1**. More decisively: an `encounter-start` service
 * would return the SAME cards from the SAME persisted outcomes, so a second service would add a discovery
 * entry, a validation branch and a test file for no different behaviour. Adding it later is that small.
 *
 * ## No `prefetch`, deliberately
 *
 * `prefetch` is the spec's mechanism for a client to ship FHIR data along with the invocation. We do not
 * evaluate data supplied on the request — cards render the most recent FINALIZED run (ADR-067) — so
 * declaring a prefetch template would make a client fetch and send resources we then ignore. That is not
 * a harmless omission to fill in: honouring prefetch means composing and evaluating a caller-supplied
 * bundle per request, which is a different capability with its own failure modes (the same reason
 * ADR-061's `mode=preview` returns 501 on a WebChart stack).
 *
 * `usageRequirements` is the spec's own field for telling a caller what it must know, so the limitation
 * is stated in the machine-readable contract rather than only in prose.
 */
import type { CdsService } from "./types.ts";

export const PATIENT_VIEW_SERVICE_ID = "workwell-compliance-patient-view";

export const CDS_SERVICES: readonly CdsService[] = [
  {
    hook: "patient-view",
    id: PATIENT_VIEW_SERVICE_ID,
    title: "WorkWell occupational-health compliance gaps",
    description:
      "Open measure gaps for this patient — occupational surveillance (OSHA), immunization and quality " +
      "measures — computed by CQL and read from the most recent completed WorkWell run.",
    usageRequirements:
      "Returns the most recent FINALIZED WorkWell evaluation for the patient; it does not evaluate data " +
      "supplied on the request, so `prefetch`, `fhirServer` and `fhirAuthorization` are accepted and " +
      "ignored. Requires a WorkWell bearer token (this service does not implement the CDS Hooks " +
      "signed-JWT profile). A patient with no completed evaluation returns an informational card saying " +
      "so, never an empty card list.",
  },
];

export function serviceById(id: string): CdsService | undefined {
  return CDS_SERVICES.find((s) => s.id === id);
}
