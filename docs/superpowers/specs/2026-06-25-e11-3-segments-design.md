# E11.3 — Segments / Risk-Groups (Design)

Date: 2026-06-25
Status: Approved (design)
Author: Taleef (with Claude)
Epic: E11 (#183) — sub-project 3 (the final E11 piece). Closes the epic's "segments / risk-groups"
acceptance: *a segment (risk group) maps a cohort → applicable rule-set; the roster grid (E10) consumes
it for column scoping + N/A* (vamsi8 CONFIGURE GROUPS; the GROUPS column in vamsi1/2).

## 1. Context

E11's rule-builder + canonical-source halves shipped: E11.1 (ADR-015, rule→CQL codegen, *CQL is
canonical*), E11.2a (titer/grace/declination), E11.2b (Rule Builder UI), E11.2c (multi-alternative
series + live Hep B repoint). The remaining E11 piece is the **segment / risk-group model**: a cohort
(who) mapped to an applicable rule-set (which measures), consumed by the E10 roster grid.

Today the roster (`backend-ts/src/compliance/roster-read-model.ts`) scopes columns by **3 hard-coded
measure-panels** (`panels.ts`: immunizations / osha / wellness), and a cell is `NA` only when a subject
has **no outcome** for a measure. `panels.ts` says it explicitly: *"Each panel scopes the roster grid to
a coherent group of measures, standing in for E11's risk-group/segment column scoping."* E11.3 is the
real thing those placeholder panels were waiting for.

The synthetic directory (`engine/synthetic/employee-catalog.ts`) gives each subject a rich `role`
(e.g. "Welder / Hazwoper Responder", "Nurse / TB Program", "Office Staff", "Industrial Hygienist /
Safety Lead"), a `site` (HQ / Plant A / Plant B / Clinic), and an attributed `providerId`. There is no
program-enrollment field — measure eligibility currently lives inside the CQL + synthetic bundles. There
is no segment schema today.

## 2. Goal / non-goals

**Goal:** a persisted, owner-gated **segment model** (cohort → applicable rule-set) with hybrid cohort
membership (predicate rule + per-employee overrides), consumed by three surfaces — the roster grid
(applicability N/A overlay + a segment filter), the per-employee compliance card, and the run pipeline
(applicability gates **case creation**) — plus a **Configure Groups** admin editor and an ADR recording
that segments are an applicability layer, never a compliance authority.

**Non-goals:** changing CQL evaluation or `Outcome Status` (ADR-008 holds — segments never decide
compliance); predicates over anything beyond `role`/`site` (no FHIR-data or program-enrollment
predicates yet); multi-tenant segments (single-tenant TWH); time-bounded / scheduled segments; importing
WebChart groups (that's E12/E13). The 3 tables are the only schema change; no other DDL.

## 3. Concept

A **segment** is a named risk-group with two halves:

- **Cohort (who):** a predicate rule over employee attributes, auto-resolving membership over the
  directory, **plus** per-employee overrides (INCLUDE forces in; EXCLUDE forces out). This is the
  "hybrid" model — rule-driven with manual corrections.
- **Applicable rule-set (which):** a set of runnable measure ids that apply to that cohort.

A subject's **applicable measures** = the union of the rule-sets of every enabled segment the subject
belongs to. A measure is **not applicable** to a subject when it is in no such rule-set.

**Reversibility invariant:** with **zero enabled segments, every measure is applicable to everyone** —
identical to today's behavior. Disabling/deleting all segments fully reverts the feature. This makes the
whole feature a safe additive overlay.

## 4. Data model (3 owner-gated tables)

Authored by Taleef in `backend-ts/src/stores/postgres/schema-pg.ts` (Pg ceiling, `workwell_spike`
schema) + `backend-ts/src/stores/schema.ts` (SQLite floor). The agent builds everything on top; the
`CREATE TABLE`s are the blocking owner-gated checkpoint (CLAUDE.md hard rule).

```sql
-- segments: one row per risk-group
id           UUID PK DEFAULT gen_random_uuid()
name         TEXT NOT NULL
description  TEXT
enabled      BOOLEAN NOT NULL DEFAULT TRUE
rule_json    JSONB NOT NULL DEFAULT '{}'::jsonb   -- cohort predicate (see §5)
created_by   TEXT
created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()

-- segment_measures: the applicable rule-set (M:N segment ↔ measure id)
segment_id   UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE
measure_id   TEXT NOT NULL
PRIMARY KEY (segment_id, measure_id)

-- segment_overrides: per-employee membership corrections
segment_id   UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE
external_id  TEXT NOT NULL                          -- employee externalId
mode         TEXT NOT NULL                          -- 'INCLUDE' | 'EXCLUDE'
PRIMARY KEY (segment_id, external_id)
```

`measure_id` / `external_id` are text keys into the synthetic registries (no FK — there is no
`employees`/`measures` table in backend-ts; the run/roster read models already key on these strings).
SQLite floor uses `TEXT` UUIDs + `INTEGER` booleans + the existing JSON-as-text convention, matching the
other floor tables.

## 5. Cohort predicate (`rule_json`)

A small, closed expression — role/site only, no nesting beyond one match group:

```jsonc
{
  "match": "ANY" | "ALL",          // how to combine conditions (default ANY)
  "conditions": [
    { "attr": "role" | "site", "op": "equals" | "contains" | "in", "value": "string" | ["s", ...] }
  ]
}
```

- `equals` — case-insensitive exact match of the attribute.
- `contains` — case-insensitive substring (matches the compound roles, e.g. `role contains "Hazwoper"`).
- `in` — attribute equals any value in the array (e.g. `site in ["Clinic","HQ"]`).
- Empty `conditions` ⇒ matches nobody (a segment with no rule relies purely on INCLUDE overrides).

## 6. Applicability engine — the shared core

`backend-ts/src/segment/segment-applicability.ts` — pure functions, no I/O, the single definition
consumed by all three surfaces:

- `matchesCohort(employee, segment): boolean` — evaluate `rule_json` over `employee.role`/`employee.site`,
  then apply overrides: an `EXCLUDE` override for this `externalId` forces `false`; an `INCLUDE` override
  forces `true`. (EXCLUDE wins ties — most conservative.)
- `applicableMeasures(employee, segments): Set<string>` — union of `segment_measures` across every
  enabled segment where `matchesCohort` is true.
- `isApplicable(employee, measureId, segments): boolean` — **true if there are zero enabled segments**
  (reversibility fallback), else `applicableMeasures(...).has(measureId)`.

A `HydratedSegment` type (`{ ...segments row, measures: string[], overrides: {externalId,mode}[] }`) is
the engine's input — assembled by the store, kept out of the pure module.

## 7. Store layer

A `SegmentStore` port (`backend-ts/src/stores/segment-store.ts`) with a SQLite-floor and a Pg-ceiling
adapter, wired in `factory.ts`, covered by the store-contract parity test:

- `listSegments(): HydratedSegment[]` — segments + their measures + overrides hydrated in one logical read.
- `getSegment(id): HydratedSegment | null`
- `createSegment(input): HydratedSegment`
- `updateSegment(id, patch): HydratedSegment` — name/description/enabled/rule_json.
- `deleteSegment(id): void` (cascades measures + overrides).
- `setMeasures(id, measureIds[])` / `setOverrides(id, overrides[])` — replace-set semantics.

## 8. Roster integration (read-time, `roster-read-model.ts`)

1. **New display state `NOT_APPLICABLE`** in `roster-vocabulary.ts` (E10.5 vocabulary), distinct from
   `NA` ("no data"). Method text: "Not applicable (no matching group)". The persisted canonical bucket is
   unchanged (ADR-008) — this is a pure display refinement, like DECLINED/IN_PROGRESS.
2. **Applicability overlay:** `buildRoster` loads enabled segments once. After deriving each cell, if
   `!isApplicable(emp, measureId, segments)` the cell is overridden to `{ status: "NOT_APPLICABLE",
   method: "Not applicable" }` regardless of any outcome. (Out-of-cohort wins over a stale outcome.)
3. **`segment` filter:** `GET /api/compliance/roster?segment=<id>` scopes **rows** to that segment's
   cohort members and **columns** to that segment's rule-set. Without `segment`, columns come from the
   existing `panel` selector and every row is shown with the applicability overlay applied.

The per-employee compliance card consumes the same filtered roster path, so it inherits the overlay with
no extra code — out-of-cohort rows render `NOT_APPLICABLE`.

## 9. Run pipeline case gating

In the outcomes→cases upsert path (`backend-ts/src/case/…` — exact seam confirmed in the plan), before
creating/upserting a case for a non-compliant outcome, check `isApplicable(employee, measureId,
enabledSegments)`. If not applicable, **skip the case** — the **outcome is still persisted with full
evidence** (ADR-008; CQL still evaluated everyone). Enabled segments are loaded once per run. Zero-segment
fallback ⇒ cases created exactly as today. No new audit type (the persisted outcome already records the
truth; the absence of a case is the intended state). Reversible: clearing segments restores today's case
set on the next run.

## 10. API + audit

- `GET /api/segments` → `HydratedSegment[]` — **all authenticated roles** (the roster filter + admin
  editor both read it).
- `GET /api/segments/:id/preview` → resolved member `externalId`s + count (rule evaluated over the
  directory, overrides applied) — for the editor's live membership preview.
- `POST /api/segments`, `PUT /api/segments/:id`, `DELETE /api/segments/:id` — **ADMIN only**
  (`authorize.ts` rule `rx("/api/segments/**") → [ADMIN]` for writes; the two GETs are PERMIT-authenticated).
- Roster gains `?segment=<id>`.
- Every write emits an audit event — `SEGMENT_CREATED` / `SEGMENT_UPDATED` / `SEGMENT_DELETED`
  (CLAUDE.md hard rule: every state change writes `audit_event`).

## 11. Configure Groups editor (PR-2, frontend)

A new ADMIN-gated surface in the `/admin` **Governance** tab (`frontend/lib/rbac.ts` mirrors the API
gate). Per segment: name, description, enabled toggle; a **rule builder** (add role/site conditions with
op equals/contains/in, match ANY/ALL); an **applicable-measures** multiselect over the runnable measures;
an **overrides** editor (search the directory, add INCLUDE/EXCLUDE). A live **membership preview** count
via `GET /api/segments/:id/preview` (or a dry-run preview of unsaved rules). Roster surfaces render the
`NOT_APPLICABLE` chip (greyed, visually distinct from `NA`) and add a segment filter control.

## 12. ADR-016

Record: **segments are an applicability layer, not a compliance authority.** CQL `Outcome Status` is
unchanged and still computed for everyone; segment applicability gates only case *creation* and *display*
(roster/card N/A). Zero enabled segments ⇒ everyone applicable (the feature is a reversible additive
overlay). Predicates are role/site only for now; richer (FHIR-data, program-enrollment) predicates and
WebChart group import are deferred to later epics.

## 13. Seeding (app data, not DDL)

An idempotent boot seed (alongside `value-set-seed` / `ensureInstanceSeeds`, detach-safe on
already-seeded stores) of ~4 demo segments so the grid shows meaningful N/A out of the box:

| Segment | Cohort rule (ANY) | Applicable rule-set |
|---|---|---|
| OSHA Safety-Sensitive | role contains Welder / Maintenance / Hazwoper / Industrial Hygienist | audiogram, hazwoper, tb_surveillance |
| Clinical Staff | site = Clinic OR role contains Nurse | flu_vaccine, tb_surveillance, mmr, varicella, hepatitis_b_vaccination_series, adult_immunization |
| Office Staff | role contains Office | hypertension, diabetes_hba1c, obesity_bmi, cholesterol_ldl |
| All Employees | (everyone — broad rule) | mmr, varicella, hepatitis_b_vaccination_series, adult_immunization, hypertension, obesity_bmi |

(Exact mappings tuned in the plan so every runnable measure is applicable to ≥1 cohort and the grid has a
healthy mix of applicable / N/A.) Idempotent by segment name.

## 14. Testing

- **Applicability unit** (`segment-applicability.test.ts`): rule eval (equals/contains/in, ANY/ALL),
  INCLUDE/EXCLUDE override precedence, union across segments, **zero-segment fallback = everyone applicable**.
- **SegmentStore contract**: floor + ceiling parity (CRUD, setMeasures/setOverrides replace-semantics,
  cascade delete).
- **Roster**: `NOT_APPLICABLE` overlay overrides an existing outcome; segment filter scopes rows+columns;
  no segments ⇒ unchanged grid.
- **Run case-gating**: out-of-cohort non-compliant outcome ⇒ no case but outcome persisted; in-cohort ⇒
  case created; zero-segment ⇒ today's behavior.
- **API + audit**: ADMIN gate on writes; `SEGMENT_*` audit events written.
- **Frontend**: editor CRUD + rule builder; roster renders N/A chip + segment filter.

## 15. PR sequencing (one spec, two PRs — mirrors E11.2c)

- **PR-1 `E11.3-segments-backend`:** owner-gated DDL (Taleef) → SegmentStore → applicability engine →
  seed → API + audit → roster overlay + segment filter → run case-gating → ADR-016. Backend only;
  frontend still renders (NOT_APPLICABLE degrades to a plain cell until PR-2).
- **PR-2 `E11.3-segments-ui`:** Configure Groups editor + roster `NOT_APPLICABLE` rendering + segment
  filter control.

**Owner-gated checkpoint:** the 3 `CREATE TABLE`s in `schema-pg.ts` + `schema.ts` are Taleef's to
author/apply. The plan pauses there unless Taleef gives explicit go-ahead for the agent to write that DDL.

## 16. Risks

- **Case-gating blast radius.** Gating case creation touches the run→case seam. Mitigated by the
  zero-segment fallback (default = today) + a focused test that out-of-cohort skips the case while the
  outcome still persists.
- **Stale roster after segment edits.** The roster reads the latest population run; editing a segment
  changes applicability immediately (read-time), but case-gating only takes effect on the **next run** —
  documented as expected (display updates live; worklist updates on re-run).
- **Floor/ceiling drift.** Three new tables across two stores — the parity contract test is the guard.
