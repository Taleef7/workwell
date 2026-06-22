# E10 — Roster-centric compliance + measure taxonomy (design)

- **Date:** 2026-06-22
- **Status:** Approved (brainstorm complete) — ready for implementation plan
- **Epic:** [#182](https://github.com/Taleef7/workwell/issues/182) · Sub-issues: #188–#192 (+ new E10.6)
- **Board:** [WorkWell — Post-Demo Roadmap (WebChart convergence)](https://github.com/users/Taleef7/projects/7) · Thread `E10 Roster + taxonomy`
- **Label:** `webchart-convergence`

## 1. Context

This is the first build slice of the **post-demo roadmap** that came out of the **June 15, 2026** demo to Doug + MIE heads (`Workwell Vision Doc.md`, Jun-15 entry). The reference system is MIE's own **WebChart / Enterprise Health "Vaccine Compliance"** module running at `dev.uw.enterprise.health` for **University of Washington**, captured in `docs/vision doc screenshots/vamsi1–8.png`.

E10 converges WorkWell toward that reference on three June-15 points that form one coherent surface:

- *"Not just bad ones, show people who are compliant too"* — a full roster, not just the exception worklist. (vamsi1/2)
- *"Each rule has its own compliance"* — per-rule status columns. (vamsi1/2/4)
- *"Vaccines — once compliant always compliant, or vaccines that need regular checkups"* — a PERMANENT vs RECURRING measure taxonomy. (vamsi4: Mumps/Rubella "2 valid doses → Compliant" vs Tetanus ">10 years → Overdue")
- *"Employee screen with their info/detail"* — a per-person compliance screen. (vamsi3/4)

## 2. Goal / non-goals

**Goal:** Flip the primary surface from an exception-only worklist to a full **"Individual Compliance Status" roster** — every employee, one column per applicable rule, status chip + plain-English method — backed by a taxonomy distinguishing permanent-immunity measures from recurring ones, plus a per-employee compliance screen.

**Non-goals (deferred):**
- Formal **risk-group / segment** model (rule-set ↔ cohort, vamsi8 CONFIGURE GROUPS) → **E11**.
- **Titer-proves-immunity** ("Allow positive titer", vamsi7) → E11 rule-builder.
- The **DUPLICATE** badge / cross-system identity (vamsi4) → **E15**.
- Population scale / multi-WebChart rollup / cron → **E13**.

## 3. Decisions (from brainstorm)

1. **Permanent measure scope = full vaccine panel** — add MMR + Varicella + Hep B series (not just one exemplar, not metadata-only). Makes the grid mirror vamsi1/2 and exercises PERMANENT authentically.
2. **Grid columns = panel/category selector** — Immunizations / OSHA Surveillance / Wellness & eCQM; pre-figures E11 segments.
3. **MMR modeled as one 2-dose measure** (not split Measles/Mumps/Rubella).
4. **Titer deferred** to E11.

## 4. Architecture approach

- **Roster read model = read-time aggregation** over existing `outcomes` (latest population run per measure), reusing `rollup-shared.ts` (`latestRunRows`, `isPopulationRun`) exactly as `hierarchy-rollup.ts` does. **No schema, no new tables.** (A materialized snapshot is an E13 scale concern.)
- **Taxonomy = CQL-authoritative + descriptive metadata.** ADR-008 forbids the backend deciding status, so `complianceClass` only routes presentation; "stays compliant forever" lives in the measure's CQL. The persisted canonical status stays the existing **5 buckets**; DECLINED/IN_PROGRESS/NA are read-time display refinements (no enum/schema change).

## 5. Section A — Measure taxonomy + immunization panel (E10.1 + E10.6)

**Taxonomy field.** Add `complianceClass: PERMANENT | RECURRING` to each measure's YAML binding (`backend-ts/measures/*.yaml`). Default `RECURRING` → all 11 existing measures unchanged. Presentation routing only:
- `RECURRING` → method = last exam / days overdue; DUE_SOON window applies (today's behavior).
- `PERMANENT` → method = N valid dose(s); DUE_SOON N/A (same treatment CMS122 already uses).

**New Immunizations panel — 3 measures, series-completion CQL, no schema** (mirrors the E6 `adult_immunization` add: seed + CQL + synthetic data, idempotent back-fill):
- **MMR** — 2 valid doses (CVX 03/94) → COMPLIANT permanently · 1 dose → IN_PROGRESS · 0 → MISSING_DATA
- **Varicella** — 2 valid doses (CVX 21) → COMPLIANT permanently · partial → IN_PROGRESS · 0 → MISSING_DATA
- **Hepatitis B** — series complete (Heplisav 2-dose CVX 189 *or* traditional 3-dose CVX 08/43/44/45) → COMPLIANT permanently · partial → IN_PROGRESS · 0 → MISSING_DATA
- All three: documented **declination** Condition → DECLINED (case kept open) · **contraindication** Condition → EXCLUDED

This is the repo's first **series-completion CQL pattern** (count valid doses ≥ N, no recency), written to match the existing inline-code-filter style, and it must expose `doseCount` + a partial flag in `expressionResults`. The resulting **Immunizations panel** = MMR · Varicella · Hep B · Tetanus (`adult_immunization`, RECURRING) · Flu (RECURRING) — lining up cell-for-cell with vamsi1/2 and putting PERMANENT next to RECURRING.

**Synthetic data.** Extend the synthetic FHIR generator to emit immunization histories for the new CVX sets across the 100 employees, deterministically spread across all states (immune / in-progress / none / declined / contraindicated).

## 6. Section B — Roster read model + API (E10.2)

`GET /api/compliance/roster` — authenticated, read-only, read-time. Built on `listOutcomesWithRun` + `latestRunRows` + `isPopulationRun` (latest population run per measure; reruns/CASE/EMPLOYEE excluded).

**Params:** `panel=immunizations|osha|wellness` (or explicit `measureId` repeats) selects columns; `status=`, `site=`, `role=`, `q=` (name/id search), `page`/`pageSize` → `X-Total-Count` header (existing worklist paging contract).

**Panel → measure map** (config):
- `immunizations`: mmr · varicella · hep_b · adult_immunization · flu_vaccine
- `osha`: audiogram · hazwoper · tb_surveillance
- `wellness`: hypertension · diabetes_hba1c · obesity_bmi · cholesterol_ldl · cms122 · cms125

**Response** (rows = subjects, one cell per panel measure):
```jsonc
{
  "panel": "immunizations",
  "columns": [{ "measureId": "mmr", "name": "MMR", "complianceClass": "PERMANENT" }, "..."],
  "rows": [{
    "subject": { "externalId": "emp-006", "name": "...", "role": "...", "site": "Plant A" },
    "cells": {
      "mmr":     { "status": "COMPLIANT",   "method": "2 valid dose(s)", "evidenceRef": {"runId":"...","outcomeId":"..."} },
      "hep_b":   { "status": "IN_PROGRESS", "method": "1 of 3 doses on file" },
      "adult_immunization": { "status": "OVERDUE", "method": "Tdap 2001-01-01 (>10y) — booster needed" },
      "flu_vaccine": { "status": "NA", "method": "Not in program" }
    }
  }]
}
```

**Three derivations the read model owns** (engine stays authoritative): the `method` string (from `evidence_json` + `complianceClass`; evidence pulled for latest-run outcomes only, bounded); the display-state refinement (Section E mapping); and the `status` filter (= subject has ≥1 panel cell in that status).

**GROUPS column.** For E10 the group dimension is **site** (4 sites) shown + filterable; `role` secondary. Formal risk-group segments are E11.

## 7. Section C — Roster grid UI (E10.3)

New top-level nav **"Compliance"** → `/compliance`, titled **"Individual Compliance Status"** (verbatim from UW). The inverse of `/cases`: shows everyone, COMPLIANT/EXCLUDED included.

**Controls bar** (mirrors vamsi1/2 header): Panel selector (Immunizations / OSHA Surveillance / Wellness & eCQM) · Status filter ("All statuses") · Site filter · patient search · page-size · **Recalculate**.

**Grid** (NITRO/semantic-table seam, `@mieweb/ui`, dark-mode safe, no new deps):
- Sticky first column = employee (name + Groups cell = site/role).
- One column per panel measure; header `scope="col"` (a11y).
- Each cell = **status chip + method subtext** (e.g. `Compliant · 2 valid dose(s)`, `Overdue · Tdap 2001-01-01 (>10y) — booster needed`, `In Progress · 1 of 3 doses`, `Declined · 2026-06-04`, `N/A`).
- Chip palette (color **and** text): COMPLIANT green · DUE_SOON amber · OVERDUE red · MISSING_DATA slate · EXCLUDED muted · DECLINED orange · IN_PROGRESS blue · NA faint dash.
- Row click → per-employee screen (E10.4); cell click → evidence drill-in.

**Recalculate** = trigger a panel-scoped run via the existing async run path, reusing #181's `RunStatusProvider` (durable progress pill + `ww:run-complete`); RBAC-gated + confirm; grid refetches on `ww:run-complete`.

## 8. Section D — Per-employee compliance screen (E10.4)

Extends the existing `/employees/[externalId]` page (header + per-measure status + cases + audit timeline + forecast already render there).

**New "Individual Compliance Status" card** (single-person mirror of vamsi4): a **RULE → STATUS → METHOD** table over every applicable measure (not just open cases), same chip/method vocabulary as the grid, each row with an **Info** expander into the CQL evidence (`expressionResults`/`why_flagged`) — reusing the existing "CQL Evidence Explorer" components.

**Actions** (matching vamsi4): **Recalculate** (reuses existing EMPLOYEE/CASE rerun-to-verify, synchronous) and **Simulate Compliance History** (advisory only — reuses the forecast pattern, never sets status; ADR-012). Linked from the roster grid and employee search. Header leaves space for the E15 DUPLICATE badge.

## 9. Section E — Status vocabulary + method derivation (E10.5)

One mapping table: `(engine canonical bucket + evidence + complianceClass) → (display state + method)`. **Persisted status stays the 5 canonical buckets** (ADR-008, no schema); DECLINED/IN_PROGRESS/NA are read-time.

**Display-state rules (in order):**
| Condition | Display state |
|---|---|
| enrollment define = false | **NA** |
| EXCLUDED bucket (contraindication/waiver) | **EXCLUDED** |
| declination define present (not excluded) | **DECLINED** (case stays open) |
| COMPLIANT bucket | **COMPLIANT** |
| PERMANENT, not compliant, `0 < doses < required` | **IN_PROGRESS** |
| DUE_SOON bucket (RECURRING only) | **DUE_SOON** |
| OVERDUE bucket | **OVERDUE** |
| enrolled, no data, 0 doses | **MISSING_DATA** |

**Method string** (per class × state): PERMANENT → `2 valid dose(s)` / `1 of 3 doses on file` / `No doses on file`; RECURRING → `Last 2025-08-10 (120 days ago)` / `Due — last 2025-06-01` / `Tdap 2001-01-01 (>10y) — booster needed` / `No Tdap on file` / `Vaccinated this season`; DECLINED `Declined 2026-06-04`; EXCLUDED `Contraindicated`; NA `Not in program`.

Requires the vaccine CQL to expose `doseCount` + a partial flag in `expressionResults` (enrollment/declination defines already exist) — all in `evidence_json` (freeform JSONB, no schema). Documented in MEASURES/DATA_MODEL.

## 10. Cross-cutting

**Error handling.** A measure with no completed population run → its column shows NA/"no run yet" (not an error). Missing/odd evidence → method falls back to the canonical bucket label; per-cell try/catch so one bad cell never breaks a row. Recalculate failure surfaces via `RunStatusProvider`'s error state; grid keeps last-good data. Roster read authenticated for all roles; Recalculate RBAC-gated to run-trigger roles (mirror `rbac.ts`).

**Testing.** Engine: headless-evaluator golden cases for the 3 vaccine measures across all states; existing 11 goldens unchanged (default RECURRING). Read model: unit tests for every display-state rule, NA derivation, panel scoping, status filter, pagination/`X-Total-Count`. Frontend: grid chips/method, panel switch, filters, per-employee card, a11y.

## 11. Sub-issue map + build order

- **E10.1** (#188) taxonomy `complianceClass`
- **E10.6** (new) Immunization vaccine panel — MMR/Varicella/Hep B series-completion CQL + CVX value sets + synthetic data + seed (no schema)
- **E10.2** (#189) roster read model + API (+ display-state mapping, method, panel config, NA)
- **E10.3** (#190) roster grid UI (panel selector)
- **E10.4** (#191) per-employee compliance screen
- **E10.5** (#192) status vocabulary (mapping table + IN_PROGRESS/DECLINED/NA + method)

**Build order:** E10.1 + E10.6 (engine/data) → E10.2 (read model) → E10.3 / E10.4 (UI); E10.5 spans the read-model→UI seam.

## 12. Guardrails (from CLAUDE.md)

- CQL `Outcome Status` remains the sole compliance authority; taxonomy/forecast never override it.
- No schema/DDL without owner sign-off (stop-and-ask). E10 is designed schema-free; adding measures mirrors the E6 no-schema seed pattern.
- Reuse `@mieweb/ui` + existing NITRO/semantic-table seam; no new dependencies.
- Every state change writes an `audit_event` (Recalculate runs already do).

## 13. References

- June 15 entry — `Workwell Vision Doc.md`
- Screenshots — `docs/vision doc screenshots/vamsi1–8.png`
- Epics: E10 #182 · E11 #183 · E12 #184 · E13 #185 · E14 #186 · E15 #187
- Related closed/open epics: E2 #72 (headless evaluator), E3 #73 (eCQM artifacts), E4 #74 (hierarchy), E6 #76 (adult_immunization add pattern), E9 #78 (CQL→SQL)
- ADR-008 (CQL authoritative / no backend status), ADR-012 (advisory forecast)
