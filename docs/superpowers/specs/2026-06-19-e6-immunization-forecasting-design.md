# E6 — Immunization & Forecasting — Design Spec

- Date: 2026-06-19
- Epic: #76 (E6 — Immunization & forecasting, Wave 3)
- Branch: `feat/issue-76-immunization-forecasting`
- Status: Approved design, pre-implementation
- Depends on: E1 ports/adapters (#71, ADR-005); mirrors E5 outreach patterns (#75, ADR-011)

## 1. Goal

Add immunization forecasting to the platform behind an ICE-ready port, plus a real
adult-immunization measure that exercises it, including contraindication and refusal handling.

The genuinely new capability is **forecasting** — telling a case manager what vaccine is *coming
due* per a real schedule, not just whether the employee is compliant today. Forecasting is
**advisory**: the CQL `Outcome Status` remains the sole compliance authority (the immunization
analog of the AI/compliance guardrail).

## 2. Measure choice (researched — real, not invented)

The roadmap names CMS117 (Childhood Immunization Status), but our synthetic population is an
**adult workforce** and CMS117 measures vaccines completed by a child's 2nd birthday — it does not
map onto Total Worker Health. Two real adult alternatives were researched:

- **CMS127 — Pneumococcal Vaccination Status for Older Adults** (MIPS #111, NQF 0043; CMS127v12/v13).
  Real CMS eCQM, documented by MIE's Enterprise Health/WebChart. Rejected: age **65+** and
  **ever/never received** — binary, no schedule, nothing to forecast, poor fit for working-age staff.
- **HEDIS Adult Immunization Status (AIS-E)** — NCQA, real measure (ECDS reporting standard),
  members **19+**, composite of influenza, Td/Tdap, zoster (50+), pneumococcal (65+), hepatitis B
  (19–59), COVID-19. **Chosen.** Multi-vaccine, each with its own schedule → forecasting is
  meaningful; fits our 19+ workforce; contraindication/refusal handling is intrinsic; slots into the
  existing "HEDIS wellness" measure category.

**Anchor: AIS-E.** The three working-age-relevant indicators and their real criteria:

| Indicator | Real AIS-E "up to date" criterion | Forecast (next due) |
|-----------|-----------------------------------|---------------------|
| Td/Tdap   | ≥1 dose within ~10 years (9y prior to start of measurement year → end) | last dose + 10y |
| Influenza | ≥1 dose Jul 1 (prior yr) → Jun 30 (measurement yr) | next flu season |
| Hepatitis B | completed series, adults 19–59 | next dose in series |

**Split of measure vs. forecast (decided during planning — synthetic model is single-event):**
the synthetic data path (`measure-bindings.ts` is auto-generated; `MeasureBinding`/`ExamConfig`/
`buildSyntheticBundle` support exactly one enrollment + one waiver + one event per measure) cannot
express a true multi-series *composite measure* without reworking shared infra used by all 10
measures. So:

- The **measure** `adult_immunization` is the **Td/Tdap single-series** indicator (a 10-year
  immunization window) — fits the existing single-event model cleanly, plus contraindication +
  refusal. This is the real AIS-E Td/Tdap indicator, not invented.
- The **forecaster** (the new capability) still covers **all three series** (Td/Tdap + influenza +
  Hep B) via its own deterministic per-subject immunization synthesis, independent of the run
  pipeline — so the forecast endpoint/panel stay rich.

The full multi-series **composite measure** and the zoster (50+) / pneumococcal (65+) indicators are
documented follow-ups (would require the shared-infra rework above).

Sources:
- NCQA AIS-E: https://www.ncqa.org/report-cards/health-plans/state-of-health-care-quality-report/adult-immunization-status-ais-e/
- CMS127 (eCQI): https://ecqi.healthit.gov/ecqm/ec/2023/cms0127v11
- CMS127 (MIE Enterprise Health docs): https://docs.enterprisehealth.com/features/quality-of-care/measures/quality-measure-specifications-and-recommended-workflows/cms-127-pneumococcal-vaccination-status-for-older-adults/
- HEDIS MY2025 adult-measures clinical guide (AIS-E criteria): https://www.alliancehealthplan.org/document-library/Adult-Measures-Practitioner-Clinical-Guide-for-HEDIS-MY2025.pdf

> Note: AIS-E is an NCQA HEDIS ECDS measure, not a CMS `CMSxxx` eCQM. It is seeded in the existing
> HEDIS wellness category (alongside the 4 current wellness measures), not as a CMS eCQM entry.
> CMS117's Draft catalog entry is left untouched. This is a demo adaptation of a real measure, not a
> certified AIS-E submission.

## 3. Scope & decomposition

One epic, three workstreams (the implementation plan phases them; may be split into sub-issues):

- **W1 — `ImmunizationForecast` port + adapters + endpoint** (the ICE-ready seam)
- **W2 — AIS-E adult immunization measure** (CQL + synthetic data + contraindication/refusal)
- **W3 — Forecast surfacing** (case-detail advisory enrichment + minimal UI)

## 4. Architecture

### 4.1 W1 — `ImmunizationForecast` port (mirrors E5 `OutreachChannel`)

New module `backend-ts/src/engine/immunization/immunization-forecast.ts`:

```ts
export type VaccineSeries = "TDAP" | "INFLUENZA" | "HEPB";
export type ForecastStatus =
  | "UP_TO_DATE" | "DUE" | "OVERDUE" | "CONTRAINDICATED" | "REFUSED";

export interface SeriesForecast {
  series: VaccineSeries;
  status: ForecastStatus;
  lastDoseDate: string | null;   // ISO date or null
  nextDueDate: string | null;    // ISO date or null (null when CONTRAINDICATED)
  dosesReceived: number;
  dosesRequired: number;         // 1 for Td/Tdap & influenza; 3 for Hep B
  reason: string | null;         // free-text reason for CONTRAINDICATED/REFUSED
}

export interface ImmunizationForecast {
  subjectId: string;
  asOf: string;                  // ISO date the forecast was computed against
  series: SeriesForecast[];
}

export interface ImmunizationForecaster {
  forecast(subjectId: string, asOf: string): ImmunizationForecast;
}
```

Adapters (selection mirrors `resolveChannel` / SendGrid inert-unless-configured):

- `simulatedForecaster` — **default**. Deterministic ACIP-style schedule math over a **per-subject
  synthetic immunization source it owns** (`syntheticImmunizationHistory(subjectId)` — deterministic
  from the subjectId hash, like `birthDate`), covering all three series independent of the run
  pipeline (Td/Tdap `lastDose + 10y`, influenza `next season`, Hep B `next dose in 3-dose series`).
  Contraindication → `CONTRAINDICATED` (no next due); refusal → `REFUSED` (still carries a next-due
  so the case manager knows what was declined).
- `iceForecaster(config)` — **inert stub**. Returns a forecast whose entries carry a
  `"ICE not wired (Doug Q5)"` reason note; performs **no** HTTP. Selected **only** when both
  `WORKWELL_IMMZ_ICE_API_KEY` and `WORKWELL_IMMZ_ICE_BASE_URL` are set.
- `resolveForecaster(env)` — returns `simulatedForecaster` by default, `iceForecaster` when
  configured. **Doug Q5 (CDS Hooks vs ICE API vs WebChart-ICE bridge) is deferred behind this single
  port** — answering it later means implementing `iceForecaster` only; no other code moves.

Schedule constants (Td/Tdap interval, Hep B dose count, flu season window, "DUE soon" lead time)
live in one place in the module so they are reviewable and testable.

### 4.2 W1 — Endpoint

`GET /api/immunization/forecast?subjectId=<externalId>&asOf=<YYYY-MM-DD>`
- Returns `ImmunizationForecast` JSON (`application/json`).
- `asOf` optional, defaults to today; validated `YYYY-MM-DD` (400 on malformed, reusing
  `routes/query-dates.ts`).
- Authenticated under `/api/**` (same posture as `/api/hierarchy/rollup`).
- Read-time over the synthetic directory + the subject's synthetic immunization data. No schema.

### 4.3 W2 — AIS-E measure

New runnable measure `adult_immunization` (**Td/Tdap single-series**, per the §2 split), sibling
files in `backend-ts/measures/`:
- `adult_immunization.yaml` — bindings (mirrors `flu_vaccine.yaml`): enrollment (adult 19+),
  Td/Tdap `event` (`type: immunization`), Td/Tdap contraindication as the `waiver` slot,
  `complianceWindowDays: 3650` (10 years). Refusal is handled by an additional define in the CQL
  (see below), not the single-event binding.
- `adult_immunization.cql`:
  - "Td/Tdap Up To Date" using the real 10-year window (`Days Since Last Td/Tdap <= 3650`).
  - `Contraindicated` (Td/Tdap) → `EXCLUDED` (uses the `waiver`-slot contraindication Condition).
  - `Refused` (Td/Tdap) → recorded, does **not** exclude (a separate refusal Condition the CQL
    detects).
  - `Outcome Status`: `EXCLUDED` if contraindicated; else `COMPLIANT` if up to date; else `OVERDUE`
    if last dose > 10y; else `DUE_SOON` if within the lead window of 10y; else `MISSING_DATA` if no
    Td/Tdap record; default `MISSING_DATA`.
  - Evidence defines expose last-dose date + up-to-date boolean + a `refused` marker for the
    `why_flagged` projection.

Seeding: add to the HEDIS wellness Active set in `ensureInstanceSeeds()` for `WORKWELL_INSTANCE`
`twh`/`ecqm` (the same path that seeds the 4 wellness measures). Catalog total becomes 61.

Synthetic data: the **measure** stays within the existing single-event path. Extend
`backend-ts/src/engine/synthetic/exam-config.ts` only to emit the **refusal** Condition for a
refused scenario (the Td/Tdap immunization event + contraindication waiver already fit
`buildSyntheticBundle`'s immunization + waiver branches). The refusal Condition needs a small
addition to `ExamConfig` + `buildSyntheticBundle` (`refused: boolean` + a refusal code on the
binding). Scenarios cover all five buckets **plus** a refused case and a contraindicated case.

The forecaster's 3-series richness comes from its **own** `syntheticImmunizationHistory(subjectId)`
(see §4.1), **not** from the measure's synthetic bundle — so the single-event measure model is
untouched by the multi-series forecast.

### 4.4 W3 — Forecast surfacing on cases

- Case-detail read model (`case-detail-read-model.ts`) is enriched with the subject's
  `ImmunizationForecast` (via `resolveForecaster(env)`), as **advisory** data — it does not affect
  the case status, which remains CQL-derived.
- `/cases/[id]` gains a small "Immunization forecast" panel listing each series with status +
  next-due date (e.g. "Td/Tdap — up to date, next due 2034-03-12"; "Hep B — dose 2/3 due now").
- Only rendered for cases whose measure is `adult_immunization` (or whenever a forecast is present).

## 5. Data model

**No schema change.** Mirrors E5:
- Forecast is computed at read-time; nothing persisted.
- Contraindication/refusal ride inside `outcomes.evidence_json` (`expressionResults` + a
  `why_flagged.refused_series` / `why_flagged.contraindicated_series` field).
- No new table; the "schema is Taleef's" rule is satisfied with nothing to write.

A production drop-in (documented only, not built): an `immunization_forecasts` cache table fed by a
real ICE adapter, analogous to the documented `PgCampaignStore`/`outreach_*` drop-in for E5.

## 6. ADR

**ADR-012 — `ImmunizationForecast` port (ICE-ready, simulated by default).** Records: the port
shape, simulated-default + inert-ICE-when-configured selection (mirrors ADR-011/SendGrid), the
read-time/no-schema decision, advisory-not-authoritative forecasting (compliance stays CQL-owned),
and that Doug Q5's integration choice is deferred behind the single `iceForecaster` seam.

## 7. Testing

- `immunization-forecast.test.ts` — simulated schedule math per series (up-to-date / due / overdue /
  contraindicated / refused), boundary dates; `resolveForecaster` returns simulated by default and
  the ICE stub only when both env vars set; ICE stub performs no HTTP and is inert.
- AIS-E CQL golden test — `adult_immunization` across all scenarios (compliant, due-soon, overdue,
  missing-data, excluded/contraindicated, refused) added to the engine golden suite over the
  synthetic bundles.
- Endpoint test — `GET /api/immunization/forecast` happy path + `asOf` validation (400) + auth gate.
- Case-enrichment test — case detail for an `adult_immunization` case includes the forecast block;
  forecast does not alter case status.
- Idempotency + audit invariants for any run/case path touched remain green (mandatory).

## 8. Docs to update (same PR)

- `ARCHITECTURE.md` — new `engine.immunization` module, the forecast endpoint, the `/cases/[id]`
  advisory panel, External Interfaces entry.
- `DATA_MODEL.md` — no new table; evidence carries refusal/contraindication + advisory forecast note;
  documented production cache drop-in.
- `MEASURES.md` — AIS-E entry under HEDIS wellness with the real §2 criteria + sources; catalog total 61.
- `DECISIONS.md` — ADR-012.
- `JOURNAL.md` — running E6 narrative.
- `README.md` — API highlight (`GET /api/immunization/forecast`) + route note.

## 9. Out of scope (YAGNI)

- Real ICE / CDS-Hooks HTTP (deferred behind `iceForecaster` until Doug Q5).
- The full multi-series **composite measure** (flu + Hep B as outcome-driving measure indicators) —
  requires reworking the shared single-event synthetic infra; documented follow-up. The forecast
  already covers all three series.
- Zoster (50+) and pneumococcal (65+) indicators (extensible later).
- A new `REFUSED` outcome bucket (refusal rides in evidence; keeps the case open).
- Any `immunization_forecasts` persistence table (documented drop-in only).
- CMS117 literal pediatric implementation / child dependents in the directory.
