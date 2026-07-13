# Independent integration research — WebChart public FHIR contract + ICE deployment

**Date:** 2026-07-13
**Status:** Findings record (no code changes). Feeds #254 (provisional answers recorded in
`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`), #262 (E12 PR-2c contract corrections), #263
(delta-eval design), and the E6 ICE seam.
**Why this exists:** the M2 milestone was framed as fully blocked on MIE answers (#254). A
public-sources research pass on 2026-07-13 showed several of those answers are publicly
verifiable today. This doc records what was found, with sources and confidence, so the
corrections survive the session and the remaining *genuinely* MIE-gated questions are a short,
precise list.

---

## 1. WebChart has a public, certified FHIR R4 API (confidence: HIGH — verified live 2026-07-13)

- **Stack:** FHIR **R4 (4.0.1)**, **US Core 7.0.0 (STU7) / USCDI v4**, **SMART App Launch 2.2.0**,
  **Bulk Data 2.0.0**. Inferno g10-certified, with nightly automated Inferno runs against the
  public sandbox.
- **Docs:** `https://docs.webchartnow.com/resources/system-specifications/fhir-application-programming-interface-api/`
  (mirrored on docs.enterprisehealth.com). The doc site 403s programmatic fetchers, but the full
  markdown source is public in **`github.com/mieweb/docs`** under
  `content/resources/system-specifications/fhir-application-programming-interface-api/`
  (`resource-specifications.md` ~6,700 lines, `oauth-2.0-tutorial.md`, `endpoints.md`,
  `terms-of-use.md`). Use raw.githubusercontent.com when the site blocks.
- **Base URL shapes:** `https://<practice>.webchartnow.com/webchart.cgi/fhir/` or
  `https://webchartnow.com/<practice>/webchart.cgi/fhir/`. JSON only
  (`application/fhir+json`) — no XML.
- **Public sandbox (live-verified):** `https://fhirr4sandbox.webchartnow.com/webchart.cgi/fhir/` —
  `GET /metadata` returns the CapabilityStatement unauthenticated; `GET /Patient` without a token
  → 401. An alternate sandbox host `https://fhirr4sandbox.fhir.webch.art/` appears in the OAuth
  examples.
- **Machine-readable directory of all live customer FHIR endpoints:**
  `https://mie.webchartnow.com/?f=layoutnouser&name=FHIR-EndPoints&json` (a FHIR `Bundle` of
  `Endpoint` resources — verified live).
- **Terms of use:** API access currently free of charge (MIE reserves the right to charge later);
  commercial-use cases beyond defaults need MIE approval (support@mieweb.com). → Registering a
  WorkWell test client against the sandbox should be disclosed in the #254 package for
  transparency, but as an MIE-sponsored project this is squarely the intended audience.

### 1.1 Auth: SMART on FHIR OAuth 2.0 — **not** a static API key

The sandbox `.well-known/smart-configuration` (fetched live 2026-07-13):

- authorization: `…/webchart.cgi/oauth/authenticate/` · token: `…/webchart.cgi/oauth/token/` ·
  jwks: `…/webchart.cgi/jwks/` · introspection: `…/webchart.cgi/oauth/introspect/`
- Grants: `authorization_code`; token endpoint auth **`private_key_jwt` (RS384)**; scopes
  `patient/*.rs`, `system/*.read`; PKCE S256; capabilities incl. `launch-standalone`,
  `launch-ehr`, `client-public`, `client-confidential-symmetric`, `permission-offline`.
- **Three documented workflows:** Patient Standalone Launch; Physician EHR Launch; and — the one
  a WorkWell server-to-server integration uses — **SMART Bulk Backend Services**:
  `client_credentials` grant with a `private_key_jwt` client assertion verified against a
  registered **JWKS URL**, scope `system/*.rs` / `system/*.read`.
- **Dynamic client registration (RFC 7591/7592)** at a `/register` endpoint, with worked curl
  examples for public, confidential, asymmetric, and bulk clients (the docs show
  Drummond/Inferno registrations). Apps can also be registered manually EHR-side via
  "Login Trusts" / the FHIR App editor (admin required).
- Example client: `github.com/mieweb/webchart-oauth-example`.

### 1.1a Sandbox probe results (2026-07-13, run from the dev machine — confirms + sharpens §1.1)

Live probes of `fhirr4sandbox.webchartnow.com` after the initial research pass:

- **Re-confirmed:** `/fhir/metadata` = FHIR 4.0.1, JSON-only, 34 resource types;
  `.well-known/smart-configuration` = token endpoint `…/webchart.cgi/oauth/token/`, token auth
  **`private_key_jwt`**, signing alg **RS384**, scopes `patient/*.rs` + **`system/*.read`**, PKCE S256.
- **Deviation:** the sandbox's `grant_types_supported` lists **only `authorization_code`** —
  `client_credentials` is *not advertised*, though the docs' Backend Services tutorial and the
  `system/*.read` scope imply it exists (Inferno g10 requires Bulk Backend Services). Needs MIE
  confirmation that backend-services is enabled on the sandbox (#254 A3/C13).
- **Dynamic registration is NOT openly enabled on the sandbox:** no `registration_endpoint` in
  `smart-configuration` **or** `openid-configuration`; `.well-known/oauth-authorization-server` is a
  missing layout module; `POST /webchart.cgi/oauth/register/`, `/webchart.cgi/register/`, and
  `/register` all fall through to the app login UI (HTTP 200 HTML). Per the docs' own wording
  ("systems **configured to allow** App Registration via RFC 7591/7592…"), registration is a
  per-system switch — the public sandbox doesn't expose it self-service; the Drummond/Inferno client
  examples in the docs were presumably registered MIE-side.
- **Sharpened #254 ask (replaces "how do we authenticate?"):** *register a WorkWell
  backend-services client on the sandbox (client_credentials + private_key_jwt; we will provide the
  JWKS / public key), or enable RFC 7591 registration for us — and confirm `client_credentials` is
  supported there despite the advertised grant list.* Everything else on our side is built.
- Operational note: the alternate host `fhirr4sandbox.fhir.webch.art` fails TLS (SNI/cert mismatch)
  from our network — use the `webchartnow.com` host.

### 1.2 Resource coverage (from the live sandbox CapabilityStatement)

32 resource types; everything the WorkWell adapter consumes is present with US Core STU7
profiles:

| Resource | Interactions | Search params |
|---|---|---|
| Patient | read, search, create, update | `_id, identifier, name, birthdate, gender, family, given` |
| Observation | read, search | `_id, patient, code, date, status, category` |
| Condition | read, search, create, update | `_id, patient, code, clinical-status, onset-date, category` |
| Procedure | read, search | `_id, patient, date, status` |
| Immunization | read, search | `_id, patient, date, status` |
| Encounter | read, search | `_id, patient, date, identifier, type, status` |

Also: AllergyIntolerance, DiagnosticReport, DocumentReference, MedicationRequest, Location,
Organization, Practitioner, PractitionerRole, Provenance, Group, and more.

### 1.3 The two corrections to WorkWell's PR-2c mock contract

`docs/WEBCHART_API_ASSUMPTIONS_2026-07.md` (the #255 mock-contract pre-build) assumed a static
bearer API key and `Patient/{id}/$everything`. Both are wrong against the real contract:

1. **Auth:** SMART Backend Services (`client_credentials` + RS384 `private_key_jwt` + hosted
   JWKS), not a bearer API key. The API-key/cookie auth belongs to the *legacy* non-FHIR API
   (§3), not the FHIR surface. → `httpWebChartClient` needs a token-acquisition layer and a
   keypair/JWKS story; the `WORKWELL_WEBCHART_API_KEY` env contract needs rethinking
   (likely → client id + private key + token endpoint).
2. **No `Patient/$everything`, no `_lastUpdated`/`_since` search, no `history`, no versioning.**
   The only operation in the CapabilityStatement is **`Group/$export`** (Bulk Data 2.0).
   Per-patient pulls must be composed from per-resource `?patient={id}` searches. → the
   adapter's fan-out becomes N parallel resource searches per patient (or bulk export);
   incremental evaluation (#263) cannot rely on modified-since search — the candidate is
   `Group/$export?_since=` (spec-defined in Bulk Data 2.0, **unverified** without credentials;
   confidence MEDIUM), with content-hash comparison as the guaranteed fallback.
3. (Minor) **Pagination is undocumented** — no `_count` in any searchParam list and no paging
   discussion in the docs. The mock's `Bundle.link[relation=next]` traversal is standard FHIR
   and safe to keep, but page-size behavior is unknown → keep as an explicit #254 question.

### 1.4 Provisional coding contract (code against this today; confirm with MIE)

```
Base:        https://<practice>.webchartnow.com/webchart.cgi/fhir/    (JSON only)
Discovery:   GET {base}/metadata                      (public)
             GET {base}/.well-known/smart-configuration
Auth (M2):   SMART Backend Services
             1. Register client with a JWKS URI (dynamic POST /register, or MIE-side Login Trust)
             2. POST {token_endpoint}: grant_type=client_credentials,
                client_assertion_type=…jwt-bearer, client_assertion=<RS384 private_key_jwt>,
                scope=system/*.read
             3. Bearer <access_token> on FHIR calls
Population:  GET {base}/Patient?…                      (follow Bundle link[next] if present)
Per patient: GET {base}/Observation?patient={id}&category=…&date=ge…
             GET {base}/Condition|Procedure|Immunization|Encounter?patient={id}
             (compose — there is NO Patient/$everything)
Bulk:        Group/$export (Bulk Data 2.0; _since likely but unverified)
Deltas:      NO _lastUpdated / history — plan full re-pulls, bulk _since, or content hashing
Errors:      401 unauthenticated; OperationOutcome supported
```

## 2. WebChart itself is not runnable locally (confidence: HIGH)

- WebChart is closed-source. All ~120 repos in `github.com/mieweb` were enumerated — no app
  server source or runnable image. On-prem deployment docs exist (licensed installs), but no
  public artifact. The `dev-wcdb` GHCR package is the **database only**.
- **Doug's "MIE open-source server" = `github.com/mieweb/opensource-server`** — the Proxmox VE
  LXC self-service container platform (Create-a-Container) WorkWell already deploys on. It is
  **not** WebChart. (It also contains `manager-control-program/`, an MCP server for the
  container manager — potentially useful for deploy tooling.)
- **Implication:** the live integration path is the **public FHIR sandbox** (or an MIE-provisioned
  staging instance — #254 Q C13); the offline path remains the #246/#259 dev-DB fixture corpus.
  Pairing a live WebChart server with the local dev-wcdb is not possible.

## 3. The legacy (non-FHIR) WebChart API — context only

`https://docs.webchartnow.com/resources/system-specifications/application-programming-interface-api/`:
RESTful GET/POST over `webchart.cgi`; cookie-session or API-key OAuth; base64-encoded
pseudo-URL queries against DB-table-shaped objects (`db/patients`, … — matching the
`wc_miehr_*` tables in dev-wcdb). Client libraries: `mieweb/mieapi-js`, `mieweb/mieapi-meteor`,
`@mieweb/mie-api-tools` (npm), `mieweb/wcexport` (Python). Relevant *only* if Enterprise Health
employer/OH fields turn out not to surface in FHIR (#254 Q B12) — the legacy API reads the raw
tables where `employer_*` demonstrably lives.

Related: Doug's Honeycomb reference is `github.com/node-on-fhir/honeycomb` (Meteor v3 Node-on-FHIR
rewrite; active) — a generic FHIR server framework, not a WebChart component.

## 4. ICE (Immunization Calculation Engine) is self-hostable today (confidence: HIGH)

The E6 `iceForecaster` seam can be backed by the real engine with zero vendor involvement:

- **Official Docker image maintained by HLN:** `hub.docker.com/r/hlnconsulting/ice`. Latest ICE
  release **2.57.2 (2026-07-08)** — actively maintained, tracks ACIP (22 vaccine groups).
  Source: `github.com/cdsframework/ice` (branch `main-v2`); wiki:
  `cdsframework.atlassian.net/wiki/spaces/ICE`.
- **Run:** `docker run --rm -d -p 32775:8080 --name ice hlnconsulting/ice:latest` — ≥2 GB RAM,
  tens-of-seconds cold start (Drools knowledge-base compile). A long-lived sidecar, not
  per-request. Useful env vars: `ICE_OUTPUT_EARLIEST_AND_OVERDUE_DATES=Y`,
  `ICE_OUTPUT_SUPPLEMENTAL_TEXT=Y`.
- **API:** REST `POST {base}/opencds-decision-support-service/api/resources/evaluate`
  (+ `/evaluateAtSpecifiedTime` for as-of forecasts — pairs with the #197 simulate flow). The
  payload is a DSS JSON envelope wrapping a **base64-encoded vMR XML `CDSInput`** (patient dob +
  gender + CVX-coded `substanceAdministrationEvents`); the response symmetrically wraps a vMR
  `CDSOutput` with per-dose evaluations and per-vaccine-group forecasts (recommendation code +
  earliest/recommended/overdue dates) — which maps directly onto the `ImmunizationForecast`
  port's next-dose-due shape. Reference client: `github.com/lrasmus/pyiceclient`; known-good
  payloads: `curl-rest-tests/*.dat` in the ICE repo. FHIR wrapper (if ever wanted):
  `github.com/cdsframework/smart-ice-client`.
- **Effort:** ~2–4 h to a verified curl round-trip; **~3–5 days** to a production-quality TS
  adapter (the cost is vMR XML build/parse + CVX mapping, not HTTP; the WebChart crosswalk
  already emits CVX). The adapter stays advisory-only per ADR-012.
- **A Java→TypeScript port of ICE is infeasible** as a side project: the clinical logic is a
  large, continuously ACIP-updated Drools rule base — reimplementing it means owning a medical
  rules engine forever. The right answer to Doug's port musing (and #254 Q D18) is: run real ICE
  as a sidecar; do any FHIR mapping in our own adapter.

## 5. Other findings from the 2026-07-13 session

- **VSAC import never run on live Neon.** DEPLOY.md marks every other owner seed "✓ Done" but
  not `pnpm resolve-valuesets` — so the live `GET /api/measures/cms122/fidelity/diff` degrades
  to `estimate` mode and the #258 literal fqm-execution ladder never fires on the deployed
  stack. Self-serve fix (no MIE dependency): a UMLS key is free self-registration →
  `DATABASE_URL=<neon> WORKWELL_VSAC_API_KEY=<key> pnpm resolve-valuesets`, then verify the
  diff responds `mode: "literal"`.
- **"Compliant anywhere = compliant everywhere" is display-only.** Doug's 2026-06-24 ask ("when
  doing quality calculations, give everybody credit regardless of who did it") is implemented
  at the E15 display layer (merged, system-tagged timeline) but **not** at the calculation
  layer — by design (ADR-022 never re-aggregates), quality snapshots/rollups count each
  tenant's record independently, so a person vaccinated in system A still reads non-compliant
  in system B's numbers. Candidate design: an additive, descriptive person-resolved quality
  view alongside the per-tenant one (ADR-008/ADR-019 intact). Untracked as of 2026-07-13 —
  needs an issue.

## 6. What remains genuinely MIE-gated after this research

| # | Question | Why it can't be self-served |
|---|---|---|
| A2 (part) | Pagination semantics (`_count`, page size, ordering) | Undocumented; needs credentials or MIE answer |
| A4 | Rate limits / latency | Operational, per-deployment |
| A5 | Non-numeric Observation serving + status values | Needs real data behind auth |
| A6 (part) | Does `Group/$export` accept `_since`? | Spec-likely; unverified without credentials |
| A7 | Production procedure coding density | Production-data question |
| A8 | Authoritative Condition/problem-list source in production | Production-data question |
| B9 | OH program enrollment home | Product/design decision |
| B10–B12 | Provider/location keys, identity keys, employer fields in FHIR | Production-data + design |
| C13 | Sanctioned staging instance (and: is sandbox self-registration OK for us?) | MIE governance |
| C14–C16 | PHI/BAA, user-auth fork, volume/measure set | Governance/strategy |
| D17 | CQL→SQL intent | Doug strategy |
| D18 | ICE timeline | Now flipped: we propose self-hosted ICE; MIE confirms preference |

Everything else in the A-section is provisionally answered — recorded inline in
`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` (marked *confirm/correct*).

## 7. Recommended next actions (recorded 2026-07-13)

1. Send the updated #254 package (now with provisional answers) — before the 2026-07-15 meeting.
2. Run the VSAC import on live Neon (§5) — lights up the literal official-CQL diff live.
3. E12 PR-2c contract correction: rewrite `httpWebChartClient` to SMART Backend Services +
   per-resource `?patient=` composition; attempt dynamic registration against the public
   sandbox; point the conformance suite at it if registration succeeds.
4. Stand up ICE via the official Docker image; spike the TS adapter behind the existing port.
5. Redesign #263 around `Group/$export?_since=` primary + content-hash fallback.
6. Open an issue for calculation-level cross-system credit (§5).
