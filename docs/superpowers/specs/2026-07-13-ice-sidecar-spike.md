# ICE sidecar spike — proven working round-trip (2026-07-13)

**Status:** ✅ **SUPERSEDED BY THE BUILD — the adapter is done** (2026-07-13, same day; ADR-029).
This document is kept as the spike record; the shipped code is
`backend-ts/src/engine/immunization/{ice-vmr,ice-forecaster,resolve-forecaster}.ts` with
`ice-live.test.ts` proving it against a real container. Answers #254 Q D18 ourselves (self-host ICE;
a Java→TS port is infeasible). Plan: `docs/superpowers/plans/2026-07-13-ice-forecaster-adapter.md`.

**Two contract facts the build discovered that this spike did NOT capture** (both cost a live
debugging round; both are now regression-tested):
1. The **request's** `base64EncodedPayload` is an **ARRAY**, not a string — a bare string is rejected
   `400 Bad Request`. (The spike noted the *response* payload is an array and missed that the request
   is too — `atob()` silently coerced the one-element array, masking it.)
2. A proposal's **vaccine group is on `<observationFocus>`, not `<substanceCode>`.** ICE proposes a
   concrete *product* for some groups (CVX 115 Tdap under focus group 200 DTP; CVX 187 Shingrix under
   focus 620 Zoster), so keying on the substance loses TDAP entirely for a subject with **no DTP
   history** — the normal adult occupational-health case. The spike's canonical test patient had DTP
   history, which hid this.

**Context:** `docs/INTEGRATION_RESEARCH_2026-07-13.md` §4 (sources, maintenance state, effort).

## What was proven today (on the dev machine)

1. **Run:** `docker run --log-opt max-size=100m --log-opt max-file=5 --rm -d -p 32775:8080 --memory=3g --name ice hlnconsulting/ice:latest`
   — the official HLN image (latest, ICE 2.57.x line). Engine was answering the evaluate endpoint
   within ~30s of container start.
2. **Round-trip:** `POST http://localhost:32775/opencds-decision-support-service/api/resources/evaluate`
   (`Content-Type: application/json`, `Accept: application/json`) with the canonical known-good
   payload from the ICE repo (`curl-rest-tests/rest-test-json-evalue.dat`) → **HTTP 200** with a full
   evaluation.
3. **Response decoded:** the vMR `CDSOutput` (base64 inside
   `finalKMEvaluationResponse[0].kmEvaluationResultData[0].data.base64EncodedPayload[0]`, ~97 KB XML)
   carried **60 per-dose evaluations** (`<substanceAdministrationEvent>`) and **17 per-vaccine-group
   forecast proposals** (`<substanceAdministrationProposal>`) with recommendation observations
   (`RECOMMENDED` / `FUTURE_RECOMMENDED` / `CONDITIONAL` / `NOT_RECOMMENDED`) and **real proposed
   dates** — `<proposedAdministrationTimeInterval low="20260701000000.000+0000"/>` (i.e. next dose
   due 2026-07-01), plus `validAdministrationTimeInterval` earliest dates.

## Contract facts a TS adapter needs (verified against the live response)

- **Request:** DSS JSON envelope; the patient data is a **base64-encoded vMR `CDSInput` XML** inside
  `dataRequirementItemData[].data.base64EncodedPayload` — dob (`<birthTime value="YYYYMMDD"/>`),
  gender, and one `<substanceAdministrationEvent>` per historical dose (CVX `substanceCode` +
  administration date). `kmId` = `org.nyc.cir / gov.nyc.cir / ICE` version. Copy
  `rest-test-json-evalue.dat` exactly, then parameterize.
- **Response envelope:** `finalKMEvaluationResponse[0].kmEvaluationResultData[0].data.base64EncodedPayload[0]`
  (note: payload is an **array**, not a string). Decode → vMR `CDSOutput` XML.
- **Forecast mapping to the `ImmunizationForecast` port:** per `<substanceAdministrationProposal>`:
  vaccine-group substance code, recommendation enum (from the nested `<observationValue>` codes),
  `proposedAdministrationTimeInterval@low` = recommended (due) date,
  `validAdministrationTimeInterval@low` = earliest date. Timestamp format `YYYYMMDDhhmmss.SSS±ZZZZ`.
- **As-of support:** `/evaluateAtSpecifiedTime` variant — pairs with the #197 simulate flow.
- **Ops:** ~2–3 GB RAM, tens-of-seconds cold start (Drools KB compile) — a long-lived sidecar,
  never per-request. Useful env: `ICE_OUTPUT_EARLIEST_AND_OVERDUE_DATES=Y`,
  `ICE_OUTPUT_SUPPLEMENTAL_TEXT=Y`.

## Adapter build plan (follow-up, ~3–5 days)

1. vMR builder: `{dob, gender, [{cvx, date}]}` → `CDSInput` XML → base64 → DSS envelope. Use
   `fast-xml-parser`? **No — no new deps**; the vMR subset needed is small enough for string
   templates + a tolerant regex/manual parse of the response (or the existing pattern of tiny
   hand-rolled XML like the QRDA stub, `fhir/qrda.ts`).
2. `iceForecaster` behind the existing port (`engine/immunization/immunization-forecast.ts`):
   selected only when `WORKWELL_IMMZ_ICE_BASE_URL` (+ key var, may be unused for a local sidecar —
   consider relaxing the both-vars predicate or documenting a dummy key) — advisory-only (ADR-012),
   timeout-bounded, deterministic fallback to `simulatedForecaster` on error.
3. Parity/behavior tests with a fixture DSS response (the captured `ice-response.json` from this
   spike is the golden — copy it into `backend-ts/spike/ice/` when the build starts).
4. Demo wiring: docker-compose entry (`infra/docker-compose.yml`, `restart: unless-stopped`,
   mem limit) — NOT the MIE demo stack by default (inert-unless-configured stands).

## Session artifacts (scratchpad, not committed)

`ice-evaluate-payload.json` (canonical request), `ice-response.json` (live response),
`ice-response-vmr.xml` (decoded output) — in the session scratchpad; regenerate any time with the
one-liner above. The `ice` container was left running on port 32775 (`docker stop ice` removes it —
it was started with `--rm`).
