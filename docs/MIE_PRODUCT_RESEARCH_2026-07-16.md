# MIE Product Landscape & the #254 Assumption Register

**Date:** 2026-07-16 · **Status:** Research record (Doug's be-self-sufficient directive, 2026-07-15
meeting) · **Companion to:** `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` (the #254 index — every
self-resolved item below is cross-linked from its Answer log) and
`docs/INTEGRATION_RESEARCH_2026-07-13.md` (the verified API contract).

Two jobs: (1) map MIE's products so it's explicit **what WorkWell is and complements**; (2) give
every still-open #254 question a **documented working assumption + what would falsify it**, so
nothing re-blocks on MIE.

---

## 1. MIE's product landscape (researched 2026-07-15/16; sources cited)

| Product | What it is | Source |
|---|---|---|
| **WebChart EHR** | MIE's flagship cloud EHR — ONC-ACB 2015-certified ambulatory EHR (primary care, specialty, student health, federal, occupational health). The platform everything else builds on. FHIR R4 / US Core 7.0.0 / USCDI v4 / SMART App Launch 2.2.0 / Bulk Data 2.0.0, Inferno g10-tested. | webchartnow.com/packages/webchart-ehr; docs.webchartnow.com FHIR API page |
| **Enterprise Health (EH)** | MIE's **occupational/employee health EHR built ON the WebChart platform** (2013; co-developed with Dow, Eli Lilly, Disney). Modules: clinical charting, **medical/health surveillance programs**, **immunization/vaccination programs**, **OSHA recordkeeping + audit-ready compliance reporting**, case management, injury care, return-to-work, onsite-clinic management. Customers incl. NASA, the VA, Phillips 66. | enterprisehealth.com + /features |
| **NoMoreClipboard** | Patient engagement / PHR / portal line. | historical MIE product line |
| **BlueHive** | **Not MIE** — a third-party occupational-health provider network that integrates with WebChart/EH via HL7 (routes orders to 20k+ external providers, returns results). Relevant as the "out-of-clinic" leg EH documents against. | bluehive.com/integrations |
| Quality reporting | WebChart advertises MACRA/QPP + MIPS workflows (the trial dashboard's "Quality Reporting — Enroll / Check MIPS Participation Status" portlet links the CMS QPP participation lookup). | docs.webchartnow.com Quality Resources |

**Shared infrastructure notes:** WebChart and EH share one docs system and one **Data Migration /
CSV import engine** (the formats PR 4's generator emits), one FHIR surface, and the
`webchart.cgi?f=<func>&s=<sub>` admin UI scheme. The dev DB (`ghcr.io/mieweb/dev-wcdb`) carries the
EH-flavored occupational fields (`employer_name`, incident/OSHA tables).

## 2. Where WorkWell sits (Doug-confirmed direction)

**WorkWell is the standards-based CQL/eCQM measure layer alongside Enterprise Health's native
operational surveillance workflows**. EH captures the occupational-health *data* (surveillance
exams, immunizations, OSHA events, encounters) and already evaluates panel due dates, required
actions, and decertification; WorkWell **pulls that data out over FHIR and computes externally
authorable CQL measures** — deterministic population runs, evidence-carrying outcomes, case
workflow, audit-first posture, and eCQM-grade exports (MeasureReport/QRDA). Doug's D17 answer fixed
the direction: **data flows WebChart→WorkWell; CQL runs on our side** (no engine-inside-the-DB, no
CQL→SQL now). The complement is CQL/standards portability and evidence, not a claim that EH lacks
its own program-specific due/compliance logic.

Module-level mapping (EH concept → WorkWell seam):

| Enterprise Health concept | WorkWell counterpart | Seam |
|---|---|---|
| Health-surveillance program membership | measure enrollment | `stampEnrollment` roster (B9) |
| Surveillance exams / labs / vitals | measure events | ingress crosswalk (`terminology.ts`) |
| Immunization program | vax measures + ICE forecasts | CVX crosswalk + ADR-029 sidecar |
| Employer / location / provider | tenant→enterprise→location→provider hierarchy | directory model (ADR-019) |
| OSHA recordkeeping (incidents) | OSHA surveillance measures (catalog) | measure catalog; incident *data* not yet consumed |
| Case management / injury care | case workflow (worklist, outreach, rerun-to-verify) | `caseflow` |
| Audit-ready reporting | append-only `audit_events` + auditor packets | `audit` |
| MIPS/QPP quality reporting | eCQM measures + MeasureReport/QRDA exports | `standards`/`fhir` |

So the demo story is: *EH-shaped data, WorkWell-computed compliance* — which is exactly what the
dev-DB proof (#246), the HAPI simulator (ADR-032), and the live teatea tenant (2026-07-16 spec)
demonstrate at increasing levels of realism.

## 3. The assumption register — every still-open #254 item

Convention: **Assumption** = what we build against today · **Falsifier** = the observation that
would change it · **Where verified** = the live surface that can confirm it without MIE.

### A2 — pagination semantics *(partially observable now)*
- **Assumption:** standard FHIR searchset `Bundle.link[relation=next]` with `_count` honored;
  no ordering guarantee relied on (the client dedupes by id across pages).
- **Falsifier:** teatea returning offset-style params, ignoring `_count`, or minting off-origin
  next links (the client's origin guard would surface this loudly).
- **Where verified:** runbook §5 records the observed page size + link shape from the live pull.

### A4 — rate limits & latency
- **Assumption:** none published; the client's conservative posture stands — serial per-patient
  composition, bounded 429/5xx retries (2, short backoff), 10s timeouts. No parallel fan-out
  against teatea until observed behavior justifies it.
- **Falsifier:** 429s on the ~30-patient pull (runbook §5 records any).

### A5 — observation representation *(observable after seeding)*
- **Assumption:** imported observations surface as FHIR `Observation` with `valueQuantity` and a
  LOINC coding resolved via the instance's observation-code compendium (the dev DB behaved this
  way: LOINC-coded numeric observations). Titer-proves-immunity (coded/text results) remains
  deferred until a coded-result example is observed.
- **Falsifier:** the runbook's post-import spot-check finding name-only (LOINC-less) or
  text-blob observations — that immediately matters to the crosswalk and gets recorded on A5.

### A6 — change signals
- **Assumption (decided design):** none usable — no `_lastUpdated`, no history. Delta evaluation
  uses **content-hash change detection** (#263 design; owner-gated `eval_state` DDL). `$export
  _since` remains unverified and is not load-bearing.
- **Falsifier:** teatea honoring `Group/$export?_since=` (worth one probe once a `Group` exists).

### A7 — procedure coding density
- **Assumption:** production procedures are denser than the dev seed's 1/99 CPT-coded rows, but we
  don't depend on it: lab-driven measures ride LOINC observations (the crosswalk's
  Observation→Procedure synthesis), and mammography enters as a completed order (runbook §4).
- **Falsifier:** a production dataset where procedures carry neither CPT nor a LOINC-mapped
  observation twin — pre-production unknowable; flagged risk, revisit at first real-customer data.

### A8 — problem list
- **Assumption:** cms122 requires a real problem-list/FHIR `Condition` carrying the Diabetes value
  set code (the teatea seed uses SNOMED CT 44054006). An ICD value on
  `Encounter.primary_diagnosis` is not sufficient: the current normalizer does not synthesize a
  Condition from Encounter data, and CQL retrieves `[Condition: "Diabetes"]`. MIE's Conditions CSV
  API can record SNOMED concept ids, but whether that record appears on the trial's FHIR Condition
  surface remains an observation to verify. Missing Condition ⇒ out of IPP, fail closed.
- **Falsifier:** a future, explicitly tested ICD→Condition normalization rule or a different
  standards-approved diagnosis source; neither is assumed today.

### B9 — OH program enrollment home
- **Assumption (now the working design):** **WorkWell-side roster** is the authoritative home —
  `stampEnrollment` + `ROSTER_ELIGIBLE_MEASURES`, with the live tenant defaulting to enroll-all
  (spec §4) and an env-JSON override. WebChart carries no `urn:workwell:vs:*` membership Condition.
- **Falsifier:** EH's surveillance-panel tables (Panel Membership Import exists in the Data
  Migration hub!) surfacing per-program membership over FHIR — then the roster gets a WebChart
  *reader* behind the same seam. Worth one look on teatea: whether panel membership manifests in
  any FHIR resource.

### B10 — provider/location keys
- **Assumption:** unresolved; the live tenant uses a **flat single-location/single-provider**
  placement (spec §1) precisely so no wrong hierarchy is baked in.
- **Falsifier/next data:** `Practitioner`/`Location`/`Organization` resources on teatea patients
  (the trial exposes all three resource types — inspect once charts exist).

### B11 — identity keys
- **Assumption:** an MRN is **system-local identity only**, keyed by
  `(WebChart instance/assigning authority, partition, value)`. MIE documents partition+MRN
  uniqueness within a database; that does not make the value globally shared, and raw MRNs must not
  drive E15 cross-system linkage. Live-tenant subjects therefore remain deliberately unlinked to
  twh/ihn people (#187 PR-3).
- **Falsifier / promotion rule:** only an explicitly documented enterprise master-person identifier
  on `Patient`/`Person` (or another MIE-confirmed shared authority) may be promoted into E15's
  `nationalId`/`matchKey` seam.

### B12 — employer/occupational fields
- **Assumption:** employer fields (`employer_name`, `employer_uid`) do **not** surface in base
  US-Core FHIR; tenant attribution for a real deployment will need either an EH extension, the
  legacy API, or deployment topology (one WorkWell per employer). The live tenant sidesteps it
  (one tenant per configured endpoint — which IS the topology answer for v1).
- **Falsifier:** an employer extension/Observation on teatea patients (check once seeded — the
  import's `patients.employer_country` hints the fields exist in the model).

### C14 — PHI/BAA · C15 — user auth · C16 — volume
- **Posture unchanged** — these were not discussed and are **not self-resolvable** (legal/contract
  + MIE-side decisions). Standing assumptions: the demo stack never receives PHI and no
  PHI-capable environment is provisioned before the BAA chain is answered
  (`docs/PRODUCTION_READINESS_2026-07.md` — C14); auth stays hardcoded demo accounts, with the
  JWT mechanics provider-agnostic for whichever of MIE-SSO/WebChart-delegated/own-OIDC wins (C15,
  #265); volume assumed **≤10k subjects initially** (trial + first integration scale — measured
  baseline ~68 ms/eval single-threaded, worker-pool 3.7–5.1× — comfortably inside a nightly
  window at 10k×14; the 120k question stays parked with #256/#263).
- These three stay flagged in every MIE conversation; they gate *production*, not the trial work.

### D17/D18 — answered
D17: WebChart→WorkWell, CQL our side (Doug); Option B (#292) dormant. D18: self-hosted ICE
(ADR-029) — residual question is only whether MIE prefers an MIE-hosted ICE eventually.

## 4. Deployability follow-ups this research surfaces

1. **Per-customer onboarding runbook** — PR 4's teatea runbook §§1–3 (keypair → JWT-screen client
   registration → probe) *is* the per-practice recipe; generalize it into `docs/DEPLOY.md` once the
   grant question (A3 residual) is settled by the first probe run.
2. **Env-var contract is complete** — the whole live integration is 3–6 `WORKWELL_WEBCHART_*` vars
   on the existing seam; no code fork per customer. That is the deployable shape: *configure, don't
   build*.
3. **The PHI gap remains the production gate** — everything in this wave is trial/synthetic;
   `PRODUCTION_READINESS_2026-07.md` items 1–2 (env split #267, auth #265) are still the floor
   before any real-customer data.
4. **HL7 ingestion exists as a WebChart-side alternative** (ADT/VXU/ORU) if FHIR read-back ever
   proves insufficient for a data class — noted, not planned.

## 5. Sources

- [`mieweb/docs` FHIR API](https://github.com/mieweb/docs/tree/master/content/resources/system-specifications/fhir-application-programming-interface-api)
  and Data Migration sources, including
  [Conditions CSV](https://github.com/mieweb/docs/blob/master/content/features/system-administration/data-migration/conditions-csv-api.md),
  [MRN import semantics](https://github.com/mieweb/docs/blob/master/content/features/system-administration/data-migration/chart-medical-record-number-mrn-import-options.md), and
  [Panel Membership](https://github.com/mieweb/docs/blob/master/content/features/health-surveillance/panel-membership-portlet.md)
  (plus their published Google-Sheet column specs)
- Live probes 2026-07-16: `teatea.webchartnow.com/webchart.cgi/fhir/{metadata,.well-known/smart-configuration}`
- [Enterprise Health](https://www.enterprisehealth.com/), webchartnow.com, and
  [BlueHive](https://bluehive.com/) product pages
- `docs/INTEGRATION_RESEARCH_2026-07-13.md` (the verified FHIR contract), `docs/WEBCHART_FHIR_MAPPING.md`
- Doug meeting 2026-07-15 (owner recollection, recorded in the #254 Answer log 2026-07-16)
