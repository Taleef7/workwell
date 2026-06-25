# E11.2b — Rule Builder UI (Design)

Date: 2026-06-24
Status: Approved (design)
Author: Taleef (with Claude)
Epic: E11 (#183) — sub-project 2b (the Rule Builder UI; consumes the E11.1 + E11.2a codegen)

## 1. Context

E11.1 (ADR-015) made `rule:` params compile to CQL (`generate-cql.ts`); E11.2a added titer/grace/declination.
Both are backend-only — there is no UI to author the params. E11.2b adds a **Rule Builder** tab to the
Studio measure editor (`/studio/[id]`): a structured form whose output is the codegen's exact input
(`{rule, bindings}`), with a **live generated-CQL preview** and an **atomic save** that persists the params
+ the generated CQL to the measure version. This is the vamsi6/7 "configure vaccine" UX for the shapes we
support; the Hep B multi-alternative-series + min-intervals + multi-CVX is **deferred**.

It fits the existing Studio authoring model exactly: tabs are DB-backed (`spec_json` + `cql_text` +
`compile_status`, runtime-editable, gated AUTHOR/ADMIN). As with the existing CQL tab, runtime-edited CQL
isn't *evaluated* until a build bakes the ELM — a **pre-existing limitation**, out of scope here.

## 2. Goal / non-goals

**Goal:** an author can pick a rule shape, fill params + binding codes + the compliance-paths toggles, see
the generated CQL live, and save it to the measure version (params round-trip on re-open).

**Non-goals:** Hep B multi-alternative-series / min-interval validation / multi-CVX (deferred); making
runtime-edited measures evaluable without a build (pre-existing, shared with the CQL tab); segments/E11.3.

## 3. Architecture

### 3.1 Backend — spec extension + two endpoints

**Spec extension (additive, no DDL — `spec_json` is JSONB).** Extend `MeasureSpec`
(`backend-ts/src/measure/measure-catalog.ts`) + `SpecUpdate` (`measure-authoring.ts`) with optional
`rule?: Rule` + `ruleBindings?: CodegenBindings` (the `generate-cql.ts` input types). `updateMeasureSpec`
projects them through. They round-trip the form; the **CQL stays canonical** in `cql_text`. `generatedCql`
is **not** stored (regenerated from the params).

**`POST /api/measures/:id/rule/preview`** (stateless live preview). Body `{rule, bindings}`. Resolves the
CQL library name: prefer the `MEASURES` registry (`MEASURES[id].library` = e.g. `"MmrSeries-1.0.0"`, split
into `library`+`version`); **fall back** to the measure record (a sanitized `measure.name` →
`CamelCaseIdentifier` + `measure.version`) so the builder also works for measures not yet in the runnable
registry (the library name only labels the generated CQL header — `library X version 'Y'` — it doesn't
affect evaluation). A shared `resolveLibrary(measureId, measure)` helper does this and is reused by save.
Then `generateCql({library, version, rule, bindings})` → `{ cql }`. Validation: 400 on a missing/invalid
`rule`/`bindings`; 404 unknown measure id; any `generateCql` throw (e.g. wrong `event.type` for the shape)
→ 400 `{ error, message }`. Gated AUTHOR/ADMIN.

**`PUT /api/measures/:id/rule`** (atomic save). Body `{rule, bindings}`. In one call: `generateCql(...)`,
persist `rule`+`ruleBindings` into `spec_json` (via the spec path) **and** the generated CQL into `cql_text`,
run `toCompileResponse(cql)` for diagnostics + persist `compile_status`, write one audit event → return
`{ cql, status, errors, warnings }`. Reuses `generateCql`, `toCompileResponse`, the measure store. Gated
AUTHOR/ADMIN. (Auth matrix already covers `POST /api/measures/**`; add a `PUT /api/measures/*/rule` rule
matching the existing `PUT /api/measures/*/cql` → AUTHOR/ADMIN.)

### 3.2 Frontend — the `RuleBuilderTab`

- Register a `"rules"` tab in `frontend/app/(dashboard)/studio/[id]/page.tsx`: add to the `Tab` union, the
  `tabs` array, `tabLabels` (`"Rule Builder"`), and a conditional render of `<RuleBuilderTab measure
  measureId api onSaved onError />` (mirrors the SpecTab prop contract). The tab is shown to all Studio
  roles but **Save is gated** by `canAuthorMeasures` (a viewer sees a read-only form, matching the other
  tabs' gating).
- `frontend/features/studio/components/RuleBuilderTab.tsx` — a structured form:
  - **Shape** selector: `series-completion` | `windowed-recency`.
  - **Series** params: `requiredDoses`; **Allow positive titer** toggle → when on, `titer` `{code, valueSet,
    minValue}` fields.
  - **Windowed** params: `windowDays`, `dueSoonDays`, `gracePeriodDays`.
  - **Bindings**: `enrollment` / `waiver` / `event` `{code, valueSet}` (event also `type`:
    procedure/immunization/observation, defaulted by shape); **Allow declination** toggle → `refusal`
    `{code, valueSet}`.
  - **Live preview**: a debounced `POST …/rule/preview` on form change → the generated CQL shown read-only
    (a `<pre>`; reuse the Monaco read-only viewer if trivial, else a styled `<pre>` — `<pre>` is fine and
    avoids Monaco wiring). Shows the preview error message on a 400.
  - **Save**: `PUT …/rule` → toast + the compile status/errors + `onSaved()` (refresh). Disabled while
    saving or when the preview has an error / required fields are empty.
  - **Hydrate** initial state from `measure.spec.rule` / `measure.spec.ruleBindings` (round-trip); else
    sensible defaults (series 2 doses / windowed 365/30).
- Reuses `useApi`, `canAuthorMeasures`, and the SpecTab input/error/toast patterns.

## 4. Data flow

```
form change → (debounced) POST /api/measures/:id/rule/preview {rule,bindings}
            → generateCql(registry library/version, rule, bindings) → { cql } → render read-only

Save → PUT /api/measures/:id/rule {rule,bindings}
     → generateCql → persist spec_json.rule/ruleBindings + cql_text + compile_status (audited)
     → { cql, status, errors, warnings } → toast + status; onSaved() refreshes the measure
```

## 5. Error / edge handling

- Preview: invalid params (e.g. windowed with `event.type=immunization`) → `generateCql` throws → 400
  `{error,message}`; the form shows the message and disables Save.
- Save: same validation; a compile ERROR is returned (status + errors) and surfaced — the save still
  persists the params/CQL (so the author can iterate), matching the CQL tab's compile-then-fix flow.
- Unknown measure id → 404. Non-AUTHOR roles → the Save button is hidden/disabled (server still gates).
- Empty/required fields → Save disabled; the preview is skipped until the shape + binding codes are set.

## 6. Testing

- **Backend:** route tests for `POST …/rule/preview` (valid series + windowed → CQL containing the right
  defines; invalid shape → 400; unknown measure → 404) and `PUT …/rule` (persists `spec.rule` +
  `cql_text`, returns compile status; auth). Reuses the seeded-SQLite measure-route test pattern.
- **Frontend:** `RuleBuilderTab.test.tsx` — renders the form; changing a field triggers a debounced preview
  fetch with the right `{rule, bindings}` body; Save calls `PUT …/rule`; hydrates from
  `measure.spec.rule`; the titer/declination toggles reveal their fields. Mirrors the SpecTab/CqlTab tests.
- **Full gate:** backend `tsc` + `node --test`; frontend `vitest` + `lint` + `build`.

## 7. Guardrails

- **RBAC AUTHOR/ADMIN** for both endpoints + Save (mirrors the spec/cql authoring gates).
- **Reuses the de-risked codegen** (ADR-015) — CQL stays the canonical execution + standards layer
  (ADR-008); the Rule Builder only authors the params + the generated CQL, it doesn't introduce a new
  evaluation path.
- **No schema/DDL** (spec_json is JSONB; the extension is additive), **no new runtime deps**.
- Pre-existing limitation (runtime-edited CQL not evaluated until a build) is unchanged and documented.

## 8. File structure

- Modify (backend): `backend-ts/src/measure/measure-catalog.ts` (`MeasureSpec` += rule/ruleBindings),
  `backend-ts/src/measure/measure-authoring.ts` (`SpecUpdate` += rule/ruleBindings; new
  `previewRule`/`saveRule` helpers reusing `generateCql`+`toCompileResponse`),
  `backend-ts/src/routes/measures.ts` (two route handlers), `backend-ts/src/auth/authorize.ts` (PUT
  `/api/measures/*/rule` → AUTHOR/ADMIN).
- Create (backend tests): extend `backend-ts/src/routes/measures.test.ts` (or a focused new test file) for
  the two endpoints.
- Create (frontend): `frontend/features/studio/components/RuleBuilderTab.tsx` (+ `__tests__/…test.tsx`).
- Modify (frontend): `frontend/app/(dashboard)/studio/[id]/page.tsx` (register the tab); the frontend
  `MeasureDetail`/spec type (`frontend/features/studio/types.ts`) += optional `rule`/`ruleBindings`.
- Docs: `docs/ARCHITECTURE.md` (§4 `/studio` tab + §7 the two endpoints), `docs/JOURNAL.md`.

## 9. References

- E11.1: `docs/superpowers/specs/2026-06-24-e11-1-rule-codegen-design.md`, ADR-015. E11.2a:
  `…-e11-2a-codegen-titer-grace-design.md`. Codegen input types: `generate-cql.ts`.
- Studio patterns: `frontend/features/studio/components/{SpecTab,CqlTab}.tsx`,
  `backend-ts/src/measure/measure-authoring.ts`, `backend-ts/src/routes/measures.ts`. vamsi6/7
  (`docs/vision doc screenshots/`).
- Follow-ons: Hep B multi-series/intervals/multi-CVX; E11.3 segments/risk-groups.
