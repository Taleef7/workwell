# WebChart API Assumptions — July 2026 Mock-Contract Pre-Build

**Status:** Working assumptions for #255 / PR-2c pre-build. These are not confirmed MIE contract
answers. The implemented client uses **Variant A: true FHIR R4**. **Variant B: proprietary REST over
`wc_miehr_*` shapes** is documented as the fallback design if MIE answers A1 that the API is not FHIR;
it is not implemented in this pre-build.

Question references point to `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`. Every assumption below is
intended to be confirmed or refuted by those questions.

---

## Variant A — True FHIR R4 API (implemented now)

### Endpoints

| Assumption | MIE question(s) |
|---|---|
| WorkWell receives a base API origin in `WORKWELL_WEBCHART_BASE_URL`; the FHIR root is `{baseUrl}/fhir`. | A1, A2, C13 |
| The worker population is enumerated with `GET {baseUrl}/fhir/Patient?_count=<pageSize>`. | A1, A2, C16 |
| Search results are a FHIR R4 searchset `Bundle` whose `entry[].resource` values are `Patient` resources with stable `Patient.id` values. | A1, A2, B11 |
| Each patient is fetched independently with `GET {baseUrl}/fhir/Patient/{id}/$everything`; the response is one FHIR Bundle for that patient only. | A1, A2 |
| The `$everything` payload includes the clinical resources the existing normalizer understands: Patient, Observation, Procedure, Condition, and, if WebChart ever exposes them, Immunization. | A1, A2, A5, A7, A8, D18 |
| WorkWell does not combine multiple patients into one evaluation bundle; the transport returns one raw payload per patient. | A2, C16 |
| Occupational-health program enrollment remains an external roster input unless MIE identifies a WebChart-side enrollment source. | B9 |

### Pagination

| Assumption | MIE question(s) |
|---|---|
| Population search is paged by `_count`; the server may cap the requested page size. | A2, A4, C16 |
| The next page is discovered from `Bundle.link[]` where `relation === "next"` and `url` is either absolute or relative to the base API origin. | A2 |
| Patient ordering is stable enough for batch traversal; WorkWell does not depend on a specific sort order for compliance semantics. | A2 |
| If a later population page fails, WorkWell evaluates the patients already listed and does not abort the whole batch. | A2, A4, C16 |

### Auth Header

| Assumption | MIE question(s) |
|---|---|
| `WORKWELL_WEBCHART_API_KEY` is sent as `Authorization: Bearer <apiKey>`. | A3, C13, C14 |
| Requests send `Accept: application/fhir+json, application/json`. | A1, A2 |
| No OAuth token exchange, refresh flow, tenant header, or per-user delegation is required for this pre-build. | A3, C13, C15 |

### Error Model

| Assumption | MIE question(s) |
|---|---|
| HTTP 429 and 5xx responses are transient and should be retried with bounded backoff. | A4 |
| 4xx responses other than 429 are terminal for that request. | A3, A4, C13 |
| Every request is bounded by an AbortController timeout. | A4, C16 |
| A malformed or failed per-patient `$everything` response degrades to a Patient-only collection Bundle plus an OperationOutcome marker, so the existing evaluator can classify that known subject as MISSING_DATA without aborting the batch. | A2, A4, C16 |
| A failed population page cannot invent patient ids that were never listed, so only already-listed patients are evaluated. | A2, C16 |
| The transport is read-only and writes no `audit_events`; downstream state-changing run/case workflows retain the audit invariant. | C14 |

---

## Variant B — Proprietary REST over `wc_miehr_*` Shapes (documented fallback, not built)

If MIE answers A1 that the API is proprietary rather than FHIR, PR-2c needs an additional row-to-FHIR
mapping layer on top of the transport, following `docs/WEBCHART_FHIR_MAPPING.md` §3. The endpoints
below name the shape WorkWell would ask for; exact paths are placeholders until MIE confirms them.

### Endpoints

| Assumption | MIE question(s) |
|---|---|
| WorkWell receives a base API origin in `WORKWELL_WEBCHART_BASE_URL`; proprietary endpoints live under `{baseUrl}/api`. | A1, A2, C13 |
| Population enumeration returns current worker rows equivalent to `patients WHERE is_patient=1`, including `pat_id`, demographics, employer fields, and MRN identifiers. Candidate path: `GET {baseUrl}/api/patients?is_patient=1&limit=<n>&cursor=<cursor>`. | A1, A2, B11, B12, C16 |
| Per-patient demographics include `patients` plus `patient_mrns`, mapped to FHIR Patient per mapping §3.1. Candidate path: `GET {baseUrl}/api/patients/{pat_id}`. | A1, A2, B11, B12 |
| Observations are fetched from an endpoint equivalent to `observations` or `observations_current` joined with `observation_codes`, preserving LOINC, units, timestamps, numeric values, and coded/text values where available. Candidate path: `GET {baseUrl}/api/patients/{pat_id}/observations`. | A1, A2, A5 |
| Procedures/orders are fetched from endpoints equivalent to `patient_procedures` and completed `encounter_orders` joined with `order_list`, preserving CPT/HCPCS/LOINC/ICD coding density. Candidate paths: `GET {baseUrl}/api/patients/{pat_id}/procedures` and `/orders`. | A1, A2, A7 |
| Conditions/problem-list data comes from the production-authoritative source MIE identifies, not from dev-seed empty tables by assumption. Candidate path: `GET {baseUrl}/api/patients/{pat_id}/conditions`. | A1, A2, A8 |
| Provider/location attribution exposes canonical provider keys and the location hierarchy needed for rollups. Candidate paths: `/api/providers`, `/api/locations`, `/api/locations/hierarchy`. | B10 |
| Occupational-health program enrollment is either omitted from this clinical API and supplied by WorkWell's roster seam, or exposed by MIE through a confirmed enrollment endpoint. | B9 |
| Immunizations remain out of WebChart transport scope unless MIE identifies a WebChart-administered vaccine source; ICE remains the expected immunization source. | D18 |

### Pagination

| Assumption | MIE question(s) |
|---|---|
| Proprietary list endpoints are paged with either cursor or offset/limit; WorkWell needs stable traversal and an explicit end-of-page signal. | A2, A4, C16 |
| Per-patient child-resource endpoints may be paged independently; WorkWell assembles one FHIR collection Bundle per patient after all pages for that patient are read. | A2, A4, C16 |
| If a page of one patient's child resources fails, WorkWell returns that patient's partial/Patient-only bundle and continues with the rest of the population. | A2, A4 |

### Auth Header

| Assumption | MIE question(s) |
|---|---|
| The same `WORKWELL_WEBCHART_API_KEY` value can be used for proprietary REST, but the final header may be `Authorization: Bearer <apiKey>`, `X-API-Key: <apiKey>`, OAuth client credentials, or another MIE-provisioned service-account scheme. | A3, C13, C14, C15 |
| Any tenant/partition scoping header, if required, must be provided by MIE before PR-2c final wiring. | A3, B11, C13, C14 |

### Error Model

| Assumption | MIE question(s) |
|---|---|
| HTTP 429 and 5xx are retryable with bounded backoff; 4xx other than 429 are terminal for that request. | A3, A4 |
| Non-FHIR rows are mapped fail-closed: unrecognized or malformed rows are skipped or converted to a Patient-only bundle rather than used to infer compliance. | A1, A5, A7, A8 |
| The row-to-FHIR mapper preserves real code systems where present and lets `normalizeWebChartBundle`/`terminology.ts` perform the existing reconciliation; it never sets or overrides `Outcome Status`. | A5, A7, A8 |
| Proprietary REST support is future PR-2c scope if A1 confirms this API shape; #255 does not build it. | A1, A2 |
