# Doug Wave — WCDB FHIR Shim + CQL→SQL Design

**Date:** 2026-07-20 · **Status:** Accepted (owner-approved plan; ADR-034) · **Target:** demo-ready
for the Thursday 2026-07-23 MIE call (Dave + Nicole/Bridget expected).

## 1. Why (the Doug directives, 2026-07-19 call)

Transcripts: `docs/doug_audio_transcript_1.txt` / `_2.txt` (local-only). Three directives:

1. **Build our own FHIR shim over the WCDB.** Not one of MIE's six FHIR servers — a tiny facade we
   control, directly over the WebChart MariaDB schema: "a simple server that if I do a FHIR query
   against it, for a patient, it lists those 50 patients as FHIR objects." Observations first;
   no security required; the point is layered, swappable API contracts.
2. **CQL→SQL** — "It would be very valuable to me if you made something that got that CQL and
   turned it into SQL queries… running those SQL queries against the WebChart database itself."
   Start with numerator/denominator, then "we build some API… is this patient compliant for this
   measure, for this date range?" Demo goal for Nicole/Dave: "here's a CQL, and boom,
   automatically the SQL is being created, because it knows our model, and it generates the
   results." This supersedes the 2026-07-15 D17 "parked" position and activates #292 Phases 0–2.
3. **MIE ecosystem:** know/use **Codify** (MIE's terminology DB; `Healthcare/CodeLookup` in the
   @mieweb/ui Storybook), finish `@mieweb/ui` work, propose WorkWell components upstream.

## 2. Architecture

```
                    ┌───────────────────────────── backend-ts (unchanged runtime) ─┐
                    │  httpWebChartClient ──► normalize ──► crosswalk ──► CQL engine │
                    │        ▲                                   (parity ORACLE)     │
                    └────────┼──────────────────────────────────────────────────────┘
   WORKWELL_WEBCHART_BASE_URL=http://localhost:8085
   + WORKWELL_WEBCHART_API_KEY=local-dev   (BOTH required — the seam
     activates only with an auth mode; base URL alone stays inert)
                             │
┌─────────────── wcdb-fhir-shim/ (standalone, owns mysql2) ────────────────┐
│  /fhir/metadata            /fhir/Patient?_count=N (same-origin link[next])│
│  /fhir/{Observation|Procedure|Condition|Immunization|Encounter}?patient= │
│  /compliance/{patientId}/{measureId}?start=&end=                          │
│  /compliance/{measureId}/cohort?start=&end=   ◄── executes sql/*.sql      │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ mysql2 (TCP :33306)
        ┌──────▼──────┐        sql/*.sql committed artifacts
        │  wcdb       │            ▲
        │  MariaDB    │   backend-ts `pnpm generate:sql`
        │  (dev-wcdb) │   (pure generateSql beside generateCql — no driver)
        └─────────────┘
```

- The shim is a **dev-wcdb-backed drop-in for the HAPI "fake WebChart"** (ADR-032/033): same seam,
  same acceptance tests (`hapi-live.test.ts` 56-patient parity), same in-app live-tenant pipeline.
- **Generation vs execution split (ADR-034):** backend-ts generates SQL purely (no driver); the
  shim executes it with bound parameters. The bundle-shaped `sqlPushdownExecutor` stub stays inert.
- **Parity (ADR-025):** per measure, per patient across the whole cohort, on two evaluation
  dates, the SQL verdict must equal the CQL engine's verdict computed over the shim's own FHIR
  output. Divergence ⇒ fix the SQL, never the oracle. **Serving is fail-closed independent of PR
  ordering** (Codex P1): the shim's compliance endpoints 409 any measure not on its
  `PARITY_CERTIFIED` allowlist, so an artifact existing on disk never implies permission to serve —
  a measure enters the allowlist only after its parity run is green. **Band coverage** (Codex P1
  round 2; corrected 2026-07-21, PR #317): the seed corpus is asserted to exercise
  COMPLIANT/OVERDUE/MISSING_DATA at the parity dates, and the suite asserts at least one subject
  changes outcome between the two dates (an end-date-ignoring SQL bug cannot pass invisibly). The
  DUE_SOON band has no seed subject *at those 2024 parity dates* — the designed ingest fixtures
  (`patients.example.yaml`) are authored **as-of `FIXTURE_DATE = 2026-07-23`** (Marcus Demoson lands
  DUE_SOON at 349 days *there*; his 2025 BP observation is in the future at the 2024 parity dates, so
  it reads MISSING_DATA then). So DUE_SOON is asserted by a **separate INGEST-FIXTURE PARITY test**
  that runs only when the fixtures are present (population > seed) and self-skips with a notice on the
  bare seed: it proves per-patient SQL==CQL **at `FIXTURE_DATE`** and that DUE_SOON is exercised —
  hardening the demo's exact claim (Zainab COMPLIANT / Marcus DUE_SOON / Priya OVERDUE / Omar
  MISSING_DATA, CQL and SQL agreeing). Coupling the DUE_SOON hard-requirement to the 2024 parity
  dates was a self-contradiction (the test's own notice said "ingest and re-run for DUE_SOON" — which
  then failed); the fixture-date pass resolves it and is strictly stronger (parity is now also proven
  at the ingest date).

## 3. Shim contract details (verified from `webchart-client.ts`)

- FHIR root `{base}/fhir`; client appends `/fhir` to `WORKWELL_WEBCHART_BASE_URL`.
- `GET /fhir/Patient?_count=N`: searchset Bundle, stable `Patient.id` = **`wc-{pat_id}`** (the
  committed-fixture id scheme — the enrollment roster and `hapi-live.test.ts` key on `wc-5` etc.;
  raw `pat_id` is used only at the SQL boundary), offset paging, `link[relation=next]` built from
  the incoming Host header (same-origin guard in the client). *(Codex P1 on this spec: an earlier
  draft said `Patient.id = pat_id` — the implementation always used `wc-{pat_id}`.)*
- Per-patient composition (no `$everything`): `GET /fhir/{type}?patient={id}&_count=N` for
  Observation, Condition, Procedure, Immunization, Encounter. `entry.search.mode="match"`,
  `subject.reference="Patient/{id}"` must match the queried id (mismatch degrades the patient).
- Statuses must be final (`Observation.status="final"`, `Procedure.status="completed"`) — the
  normalizer status-gates events. Real LOINC/CPT codings; the crosswalk reconciles to measure
  codings. Enrollment Conditions are stamped WorkWell-side (`enrollment/roster.ts`) — never emitted
  by the shim. Condition/Immunization/Encounter return valid empty searchsets.
- `/fhir/metadata` minimal CapabilityStatement (the live-test availability probe).
- Auth: `Authorization: Bearer` accepted, not enforced (static-bearer mode of the seam).

## 4. WCDB source mapping (from `scripts/webchart-devdb-export.ts`, kept in sync by parity tests)

| FHIR | WCDB source | Notes |
|---|---|---|
| Patient | `patients` WHERE `is_patient=1` (56) | `pat_id`, name, sex, birth_date |
| Observation | `observations_current ⋈ observation_codes` (loinc_num non-empty) | value `obs_result_dec`, date `COALESCE(obs_result_dt, obs_ts)`, LOINC coding, status final |
| Procedure | `patient_procedures` (cpt_code non-empty) | CPT if `/^\d{5}$/` else HCPCS, status completed |

Data reality (verified 2026-07-20): LOINC by distinct patients — BMI `39156-5`=13, systolic
`8480-6`=9, diastolic `8462-4`=9, HbA1c `4548-4`=4, LDL `2089-1`=1; only 1 real CPT procedure row.
⇒ demo measures are observation-based windowed-recency: **hypertension** (8480-6, primary),
**obesity_bmi** (39156-5, best coverage — rule params derived from its binding), **diabetes_hba1c**
(stretch), **cholesterol_ldl** (kept as the honest sparse-data example). Final set gated in PR-4.

## 5. CQL→SQL (`generateSql`)

- `backend-ts/src/engine/cql/codegen/generate-sql.ts`, sibling of `generate-cql.ts`, reusing the
  `Rule` union + `validateRule` + `MEASURE_BINDINGS`/crosswalk LOINCs. Pure string templating,
  zero deps, parameterized (`?` placeholders) MariaDB SQL over
  `patients ⋈ observations_current ⋈ observation_codes`.
- **Honest scope (Codex P2):** this is *rule-parameter→SQL templating*, not general CQL parsing.
  `hypertension`/`cholesterol_ldl` carry YAML `rule:` blocks; `obesity_bmi`/`diabetes_hba1c` do
  not — their registry params are pinned to the **hand-written CQL band literals** by the
  drift-guard test (which, after review round 2, pins ALL FOUR measures to their `.cql` bands, the
  runtime build source, in addition to the YAML where present). A threshold edit anywhere fails
  the suite until the params and regenerated SQL follow.
- Windowed-recency semantics mirror the CQL bands exactly: denominator = eligible patients
  (is_patient=1); **numerator = COMPLIANT only**, i.e. days-since-most-recent-event
  `<= windowDays − dueSoonDays` (the CQL "Compliant" cutoff — hypertension: ≤335). The full band
  set is emitted (`DUE_SOON` up to `windowDays + gracePeriodDays`, `OVERDUE` beyond, `MISSING_DATA`
  on no event), so a DUE_SOON or OVERDUE patient is never counted compliant. Per-patient + cohort
  variants. *(Codex P1 on this spec: an earlier draft described the numerator as "within
  windowDays + grace" — the implementation always used the CQL compliant cutoff, and the ADR-025
  parity gate proves it per patient.)*
- `pnpm generate:sql` writes `wcdb-fhir-shim/sql/{measure}.sql` with a generated-file header;
  snapshot + freshness tests guard drift. **Run live on the call — the "boom" moment.**
- AI framing: the translations were AI-derived from the CQL + schema, then locked as
  deterministic, parity-tested templates (ADR-008-compatible). Optional live-LLM garnish only.
- Series-completion SQL deferred (#292 follow-up): no WCDB immunization table ⇒ unpar(it)able.

## 6. Codify / @mieweb/ui (timeboxed)

`CodeLookup` is in MIE's Storybook but NOT exported by installed `@mieweb/ui@0.6.1` (no healthcare
subpath). Decision tree: probe dev prereleases → if exported, wire into Studio `ValueSetsTab`
behind a UI flag; else document (`docs/mieweb-ui-migration/CODELOOKUP_STATUS.md`) + file the
upstream publish ask (mirrors the standing @mieweb/datavis ask) as a Thursday talking point.
Upstream-contribution candidates to present: ChartDataTable, ComplianceChip/DeliveryChip tier,
RosterMobileCards, the NitroGrid SSR-safe seam, OshaReferenceCombobox.

## 7. Out of scope this wave

Series-completion SQL; wiring SQL into the app's `MeasureExecutor`; a backend
`/api/terminology/search`; vendoring CodeLookup; any teatea/live-instance work (still MIE-gated on
client registration); any schema/DDL; any PHI.
