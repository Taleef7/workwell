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

---

## A. API contract (blocks E12 PR-2c — the live transport; our critical path)

**A1. API shape.** Is the integration surface a true FHIR R4 API (returns FHIR resources), or a
proprietary REST API over the `wc_miehr_*` schema? *(Determines whether our normalizer is
pass-through + reconciliation, or also maps rows→FHIR per our mapping doc §3.)*

**A2. Endpoints & population read.** How do we (a) enumerate the worker population and (b) fetch one
patient's clinical data — FHIR `$everything`/search, Bulk `$export`, or per-resource endpoints? Exact
pagination semantics (page size limits, cursor vs offset, ordering guarantees)?

**A3. Auth.** Mechanism (bearer / OAuth client-credentials / API key header), token lifetime, and the
process for provisioning a service account for WorkWell.

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

---

## Answer log

*(record answers here, dated, as they arrive)*
