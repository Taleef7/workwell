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
- **Parity (ADR-025):** per measure, per patient across the 56-patient cohort, the SQL verdict
  must equal the CQL engine's verdict computed over the shim's own FHIR output. Divergence ⇒ fix
  the SQL, never the oracle.

## 3. Shim contract details (verified from `webchart-client.ts`)

- FHIR root `{base}/fhir`; client appends `/fhir` to `WORKWELL_WEBCHART_BASE_URL`.
- `GET /fhir/Patient?_count=N`: searchset Bundle, stable `Patient.id` (= `pat_id`), offset paging,
  `link[relation=next]` built from the incoming Host header (same-origin guard in the client).
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
- Windowed-recency semantics: denominator = eligible patients (is_patient=1); numerator = patients
  whose most recent qualifying observation falls within `windowDays` of the period end
  (grace folded in as `windowDays + gracePeriodDays`). Per-patient + cohort variants.
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
