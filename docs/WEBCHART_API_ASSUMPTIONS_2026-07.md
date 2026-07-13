# WebChart API Assumptions — July 2026 (Verified-Contract Revision)

**Status (revised 2026-07-13 — PR-2c / ADR-028):** Variant A below is no longer a blind mock — it is
the **publicly verified WebChart FHIR R4 contract**, live-checked against the public sandbox
(`https://fhirr4sandbox.webchartnow.com/webchart.cgi/fhir/` CapabilityStatement +
`.well-known/smart-configuration`, fetched 2026-07-13; sources + confidence in
`docs/INTEGRATION_RESEARCH_2026-07-13.md`), and `httpWebChartClient` now implements it. Two original
assumptions were **corrected**: auth is SMART Backend Services (not a static API key), and there is
**no `Patient/$everything`** (per-resource composition). Rows are tagged **[VERIFIED]** (public
docs/live sandbox) or **[ASSUMED]** (still needs the MIE answer). **Variant B: proprietary REST over
`wc_miehr_*` shapes** remains documented as the fallback design; it is not implemented.

Question references point to `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`.

---

## Variant A — True FHIR R4 API (implemented; verified where tagged)

### Endpoints

| Assumption | Status | MIE question(s) |
|---|---|---|
| WorkWell receives a base API origin+app path in `WORKWELL_WEBCHART_BASE_URL` (e.g. `https://<practice>.webchartnow.com/webchart.cgi`); the FHIR root is `{baseUrl}/fhir`. | [VERIFIED] (endpoint directory + sandbox) | A1, C13 |
| The API is FHIR **R4 (4.0.1)**, US Core 7.0.0, JSON only (`application/fhir+json`). | [VERIFIED] | A1 |
| The worker population is enumerated with `GET {baseUrl}/fhir/Patient?_count=<pageSize>`. | [VERIFIED] Patient search exists; `_count` is [ASSUMED] (undocumented) | A2, C16 |
| Search results are a FHIR R4 searchset `Bundle` whose `entry[].resource` values are `Patient` resources with stable `Patient.id` values. | [VERIFIED] | A2, B11 |
| ~~Each patient is fetched with `GET /fhir/Patient/{id}/$everything`.~~ **CORRECTED:** the CapabilityStatement exposes **no `$everything`** — each patient is composed from paged per-resource searches `GET {baseUrl}/fhir/{Observation\|Condition\|Procedure\|Immunization\|Encounter}?patient={id}`, all supported with a `patient` search param. The only operation is `Group/$export` (Bulk Data 2.0). | [VERIFIED] | A2 |
| WorkWell does not combine multiple patients into one evaluation bundle; the transport composes one collection Bundle per patient. | design invariant | A2, C16 |
| Any per-resource fetch failure degrades the **whole patient** to the fallback bundle (partial clinical data never evaluates). | design invariant (ADR-028) | A2, A4 |
| Occupational-health program enrollment remains an external roster input unless MIE identifies a WebChart-side enrollment source. | [ASSUMED] | B9 |

### Pagination

| Assumption | Status | MIE question(s) |
|---|---|---|
| Searches are paged by `_count`; the server may cap the requested page size. | [ASSUMED] — `_count` and page size are **undocumented**; kept as the standard-FHIR conservative default | A2, A4, C16 |
| The next page is discovered from `Bundle.link[]` where `relation === "next"` and `url` is either absolute or relative; off-origin next links are refused (token protection). | [ASSUMED] (standard FHIR) | A2 |
| Patient ordering is stable enough for batch traversal; WorkWell does not depend on a specific sort order for compliance semantics. | [ASSUMED] | A2 |
| If a later population page fails, WorkWell evaluates the patients already listed and does not abort the whole batch. | design invariant | A2, A4, C16 |
| No `_lastUpdated` search, no `history`, no versioning on any resource; the incremental-eval candidate is `Group/$export?_since=` (spec-defined, unverified). | [VERIFIED] (absence, from the CapabilityStatement); `_since` [ASSUMED] | A6 |

### Auth

| Assumption | Status | MIE question(s) |
|---|---|---|
| ~~`WORKWELL_WEBCHART_API_KEY` is sent as `Authorization: Bearer <apiKey>`.~~ **CORRECTED:** auth is **SMART on FHIR OAuth 2.0**; server-to-server uses **SMART Bulk Backend Services** — `client_credentials` grant with an RS384 `private_key_jwt` client assertion verified against the client's registered JWKS, scope `system/*.rs` (SMART v2 read+search — the documented bulk-registration grant; the live sandbox smart-configuration also advertises v1-style `system/*.read`, so the scope stays env-overridable); token endpoint from `{base}/fhir/.well-known/smart-configuration`. Implemented in `smart-backend-auth.ts`; selected by `WORKWELL_WEBCHART_CLIENT_ID`+`WORKWELL_WEBCHART_PRIVATE_KEY`. The legacy static-bearer mode is retained for fixtures/tests/proxies. | [VERIFIED] (sandbox smart-configuration + OAuth tutorial) | A3 |
| Client provisioning: dynamic client registration (RFC 7591) at `/register`, or manual EHR-side registration (Login Trusts / FHIR App editor). Production provisioning process + token lifetime still needed from MIE. | [VERIFIED] mechanism; [ASSUMED] process | A3, C13 |
| Requests send `Accept: application/fhir+json, application/json`. | [VERIFIED] (JSON-only API) | A1 |
| A 401 on a FHIR call means an expired/revoked token: invalidate the cached token, re-exchange once, retry the request once. | design invariant | A3 |

### Error Model

| Assumption | Status | MIE question(s) |
|---|---|---|
| HTTP 429 and 5xx responses are transient and should be retried with bounded backoff. | [ASSUMED] | A4 |
| 4xx responses other than 429 (and the single 401 re-auth) are terminal for that request. | [ASSUMED] | A3, A4 |
| Every request is bounded by an AbortController timeout. | design invariant | A4, C16 |
| A malformed or failed per-resource search degrades that patient to a Patient-only collection Bundle plus an OperationOutcome marker, so the evaluator classifies that known subject as MISSING_DATA without aborting the batch. | design invariant (ADR-028) | A2, A4, C16 |
| A failed population page cannot invent patient ids that were never listed, so only already-listed patients are evaluated. | design invariant | A2, C16 |
| The transport is read-only and writes no `audit_events`; downstream state-changing run/case workflows retain the audit invariant. | design invariant | C14 |

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
