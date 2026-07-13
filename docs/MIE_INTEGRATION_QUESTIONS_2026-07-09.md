# WebChart Integration — Questions & Requirements for MIE

**Date:** 2026-07-09
**From:** Taleef (WorkWell Measure Studio)
**To:** Doug / Dave Carlson (MIE)
**Purpose:** These answers are all that stands between WorkWell and live WebChart integration. We have
a working WebChart→FHIR adapter proven end-to-end against MIE's own seeded dev DB
(`ghcr.io/mieweb/dev-wcdb`) — the offline proof evaluates real dev-DB patients through the unchanged
CQL engine and prints per-measure outcomes (`pnpm evaluate:webchart-devdb`; 28 real non-MISSING_DATA
outcomes on the sample). The live HTTP transport (`httpWebChartClient`) is a deferred seam waiting
only on the contract details below. Attachments: the dev-DB evaluation output table;
`docs/TERMINOLOGY_AUDIT_2026-07-08.md` (2026 three-way terminology verification).

**How to answer:** inline under each question is fine. Answers are recorded here (dated) as they
arrive; each question notes which WorkWell workstream it unblocks.

> **Update 2026-07-13 — provisional answers from public sources.** We researched MIE's public
> documentation (`docs.webchartnow.com` via `github.com/mieweb/docs`) and live-verified the public
> FHIR sandbox (`https://fhirr4sandbox.webchartnow.com/webchart.cgi/fhir/` — CapabilityStatement +
> `.well-known/smart-configuration`, fetched 2026-07-13). Several A-section questions now carry a
> **Provisional answer (self-research — please confirm/correct)** block; only confirmation is
> needed there, not a from-scratch answer. Full findings, sources, and confidence levels:
> `docs/INTEGRATION_RESEARCH_2026-07-13.md`.

---

## A. API contract (blocks E12 PR-2c — the live transport; our critical path)

**A1. API shape.** Is the integration surface a true FHIR R4 API (returns FHIR resources), or a
proprietary REST API over the `wc_miehr_*` schema? *(Determines whether our normalizer is
pass-through + reconciliation, or also maps rows→FHIR per our mapping doc §3.)*

> **Provisional answer (self-research 2026-07-13 — please confirm/correct):** WebChart exposes a
> certified **FHIR R4 (4.0.1)** API — US Core 7.0.0 (STU7)/USCDI v4, SMART App Launch 2.2,
> Bulk Data 2.0, Inferno g10-certified; JSON only (`application/fhir+json`). Base shape
> `https://<practice>.webchartnow.com/webchart.cgi/fhir/`. A legacy non-FHIR JSON API over the
> `wc_miehr_*` tables also exists (`mieapi-js` et al.). **Please confirm the FHIR R4 API is the
> intended integration surface for WorkWell** (we assume yes; the legacy API would only matter if
> employer/OH fields don't surface in FHIR — see B12).

**A2. Endpoints & population read.** How do we (a) enumerate the worker population and (b) fetch one
patient's clinical data — FHIR `$everything`/search, Bulk `$export`, or per-resource endpoints? Exact
pagination semantics (page size limits, cursor vs offset, ordering guarantees)?

> **Provisional answer (self-research 2026-07-13 — please confirm/correct):** the live sandbox
> CapabilityStatement shows **no `Patient/$everything`**; the only operation is **`Group/$export`**
> (Bulk Data 2.0). So: population via `GET /Patient` search, per-patient data composed from
> per-resource searches (`Observation|Condition|Procedure|Immunization|Encounter?patient={id}`), or
> bulk via `Group/$export`. **Still open: pagination semantics** — no `_count` is documented and
> the docs don't describe paging; we will follow standard `Bundle.link[next]` unless you tell us
> otherwise. Please confirm the per-resource composition approach and describe page-size behavior.

**A3. Auth.** Mechanism (bearer / OAuth client-credentials / API key header), token lifetime, and the
process for provisioning a service account for WorkWell.

> **Provisional answer (self-research 2026-07-13 — please confirm/correct):** SMART on FHIR
> OAuth 2.0. For server-to-server, **SMART Bulk Backend Services**: `client_credentials` grant with
> an RS384 `private_key_jwt` client assertion verified against a registered **JWKS URL**, scope
> `system/*.rs` per the documented bulk-registration example (the sandbox smart-configuration
> also advertises v1-style `system/*.read` — please confirm which form registrations grant). The docs describe **dynamic client registration (RFC 7591)** at `/register`
> (plus manual registration via Login Trusts / the FHIR App editor). Our HTTP client now implements
> this contract (SMART Backend Services, RS384 private_key_jwt). **Probe result (2026-07-13):** the
> public sandbox does **not** expose a registration endpoint (none advertised in any well-known
> document; `/register` paths fall through to the login UI), and its `grant_types_supported`
> advertises only `authorization_code`. **Concrete ask:** (a) register a WorkWell backend-services
> client on the sandbox (client_credentials + private_key_jwt — we'll provide the JWKS/public key),
> or enable RFC 7591 for us; (b) confirm `client_credentials` is supported on the sandbox despite
> the advertised grant list; (c) the provisioning process + token lifetime for a production service
> account.

**A4. Rate limits & latency.** Rate limits, quotas, concurrency ceilings, and expected p50/p95 latency
per call — this sizes our batch evaluation windows.

**A5. Observation representation.** For non-numeric results, does the API serve the full
`observations` model (`obs_result` text, `obs_result_code` coded answers) or the
`observations_current` numeric fast-path? *(The dev seed has `observations` empty; titer-proves-
immunity and coded results depend on this.)*

**A6. Change signals.** Does the API expose `meta.lastUpdated`, a modified-since/`_since` filter,
resource history, or any subscription/webhook mechanism? *(This decides our incremental re-evaluation
design — re-evaluating only patients whose data changed. If none exists we will hash bundle content;
we'd rather know now.)*

> **Provisional answer (self-research 2026-07-13 — please confirm/correct):** the CapabilityStatement
> shows **no `_lastUpdated` search parameter, no `history` interaction, no versioning** on any
> resource. The one candidate is Bulk Data 2.0's kickoff **`_since`** parameter on `Group/$export`
> (spec-defined; we could not verify acceptance without credentials). **Please confirm whether
> `$export?_since=` works**; if not, we will proceed with content-hash change detection.

**A7. Procedure coding density.** The dev seed has 1 of 99 `patient_procedures` rows CPT-coded — is
production materially denser? Which code systems are reliably present on procedures?

**A8. Problem list.** Which table/endpoint is the authoritative Condition/problem-list source in
production? (`patient_conditions` / `patient_diagnosis` are empty in the dev seed; encounter
diagnoses are ICD on `encounters.primary_diagnosis`.)

## B. Domain / data model

**B9. OH program enrollment.** Where does occupational-health program membership (hearing
conservation, HAZWOPER, TB screening, …) live in a real deployment — WebChart-side, or is a
WorkWell-side roster the intended design? *(Our measures gate on enrollment; we built a roster seam
that works either way — `stampEnrollment` — and need to know the authoritative home.)*

**B10. Provider/location keys.** Canonical provider key for hierarchy attribution: `users.*` or the
provider rows in `patients` (`is_patient=0`)? Is `locations_hierarchy` the authoritative
enterprise→location tree?

**B11. Identity.** Are `patient_mrns` (with `wc_partition`, multiple MRNs per patient) the
cross-system identity key we should build on? Is there an enterprise master-person identifier?
*(Feeds our E15 cross-system identity layer — match keys, duplicate detection, mobility.)*

**B12. Employer/occupational fields.** Are `employer_name`, `employer_uid`, `employment_status`
reliable enough in production to drive tenant/site attribution for a Total-Worker-Health rollup?

## C. Environment & governance

**C13. Staging instance.** Can MIE provide a staging/dev WebChart instance reachable over HTTP with
test credentials and synthetic/de-identified data? *(The single biggest integration accelerator —
our conformance suite is ready to point at it.)*

> **Partially self-served (2026-07-13):** we found the **public FHIR R4 sandbox**
> (`https://fhirr4sandbox.webchartnow.com/webchart.cgi/fhir/`) and plan to register a test client
> against it (see A3). Still valuable from MIE: a staging instance whose data carries the
> **Enterprise Health employer/OH fields** (B12) — the sandbox's data shape for those is unknown.

**C14. PHI/BAA constraints.** When real data flows: where may WorkWell run (MIE infrastructure only?
is our managed-Postgres tier eligible?), encryption/retention requirements, and who owns the BAA
chain? *(Our current demo stack will never receive PHI; we need the target posture to design the
production environment split.)*

**C15. User auth.** Should WorkWell authenticate users against MIE SSO / WebChart sessions, or run
its own directory (OIDC)? *(WorkWell currently uses hardcoded demo accounts by design; we won't build
production auth until this is answered.)*

**C16. Volume & measure set.** Realistic production population size(s), and the initial measure set
MIE cares about first? *(Decides whether incremental evaluation is a launch requirement or a
fast-follow; our measured baseline is ~60 ms/evaluation single-threaded, parallelizable.)*

## D. Strategic (Doug)

**D17. The "CQL → SQL" fork, re-asked formally.** Is the goal to run the measure engine **inside
WebChart's database**, or to **replace hand-written SQL reports** with a measure engine fed from
WebChart's data? We've built the architecture so either answer is safe (ADR-025: pluggable
`MeasureExecutor`; FHIR-native default + correctness oracle; SQL-pushdown as a parity-gated future
executor) — but the answer determines whether a scoped SQL-pushdown executor ever gets scheduled, and
whether data egress is a policy constraint.

**D18. ICE timeline.** Immunization data is routed via ICE per the 2026-07-03 decision (the WebChart
adapter does not source immunizations). When is an ICE surface available to integrate against, and
what does its contract look like?

> **Provisional answer / proposal (self-research 2026-07-13):** we can self-host ICE — HLN
> publishes an official, actively maintained Docker image (`hlnconsulting/ice`; latest release
> 2.57.2, 2026-07-08) exposing the OpenCDS DSS REST endpoint (vMR payloads). We plan to run it as
> a sidecar and back our existing `ImmunizationForecast` port with it (advisory-only, ADR-012).
> **Question becomes:** does MIE prefer we integrate against an MIE-hosted ICE instance instead,
> and is there one? Also, on the Java→TypeScript port idea: our assessment is it's infeasible as
> a side project (ICE's value is HLN maintaining the ACIP-updated Drools rule base) — running the
> real engine is the right call. Happy to discuss.

---

## Answer log

*(record answers here, dated, as they arrive)*

- **2026-07-13 (self-research, pending MIE confirmation):** provisional answers recorded inline
  above for A1 (FHIR R4/US Core 7/SMART, JSON-only), A2 (no `$everything`; per-resource
  `?patient=` composition + `Group/$export`; pagination still open), A3 (SMART Backend Services,
  `private_key_jwt` + JWKS, dynamic registration), A6 (no `_lastUpdated`/history; `$export
  _since` unverified), C13 (public sandbox found), D18 (self-hosted ICE proposed; TS port
  assessed infeasible). Sources + confidence: `docs/INTEGRATION_RESEARCH_2026-07-13.md`.
- **2026-07-13 (sandbox probe):** dynamic registration is **not** openly enabled on the public
  sandbox (no `registration_endpoint` advertised; `/register` paths fall through to the UI) and
  `client_credentials` is not in its advertised grant list — so the A3/C13 ask is now concrete:
  **register a WorkWell backend-services client for us (JWKS attached) or enable RFC 7591**, and
  confirm backend-services support on the sandbox. Details: `INTEGRATION_RESEARCH_2026-07-13.md`
  §1.1a. Meanwhile the transport itself is already rebuilt to the verified contract (E12 PR-2c
  branch; ADR-028) — only credentials stand between us and a live sandbox evaluation.
