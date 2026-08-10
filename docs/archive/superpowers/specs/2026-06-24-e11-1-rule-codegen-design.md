# E11.1 — Rule-params → CQL codegen + canonical ADR (Design)

Date: 2026-06-24
Status: Approved (design)
Author: Taleef (with Claude)
Epic: E11 (#183) — sub-project 1 of 3

## 1. Context

E11 adds a vaccine-aware **Rule Builder** so non-CQL authors can define compliance rules as structured
params, plus a **segments/risk-groups** model — and must record **what is canonical** (issue #183, tied
to Doug Q1/Q2). The decision (this sub-project): **CQL stays canonical** — structured rule-params compile
**to** CQL (codegen), preserving the one execution path (CQL→ELM) and the eCQM/standards-fidelity story
(E14 import/diff), while making thresholds editable without hand-writing CQL.

E11 decomposes into three specs, built in order: **E11.1 (this)** the canonical ADR + codegen foundation;
**E11.2** the Rule Builder UI (emits the `rule:` params); **E11.3** segments/risk-groups (cohort → rule-set;
the roster grid consumes it). This spec is **E11.1 only**.

**What exists (ADR-006/008):** YAML files (`backend-ts/measures/*.yaml`) are the canonical **binding** layer
(codes, value sets, window, dose count); **CQL** owns the **outcome logic** (`Outcome Status`); ELM is the
executor. Today the rule *thresholds* (e.g. "≥ 2 doses", "365-day window") are **hand-written inside the
CQL** — the YAML's `series.requiredDoses` / `complianceWindowDays` drive the synthetic data + bindings, not
the CQL logic. Codegen closes that gap: the CQL is **generated from** those params.

## 2. Goal / non-goals

**Goal:** A deterministic codegen that turns a measure's structured `rule:` params into CQL **byte-for-byte
behaviorally equivalent** to today's hand-written CQL, proven at golden-parity — for the two dominant rule
shapes (series-completion + windowed-recency). Plus the canonical-decision ADR.

**Non-goals (later sub-projects / increments):** the Rule Builder UI (E11.2); segments/risk-groups (E11.3);
titer-proves-immunity + multi-CVX/Heplisav nuance (E11.2 rule-builder); the value-based shape (cms122) and
the eCQM measures (kept hand-written — codegen is opt-in). **No cutover** this sub-project — the hand-written
`.cql` stays the build's source of truth; the generated CQL is produced alongside and asserted equivalent.

## 3. The decision — ADR-015 (canonical model)

**ADR-015: CQL is canonical; rule-params compile to CQL (codegen).** Record in `docs/DECISIONS.md`:
- CQL/ELM is the **sole execution + standards-fidelity layer** (unchanged; ADR-008 holds — `Outcome Status`
  is the only compliance authority).
- A measure's structured **`rule:` block** (new, in its YAML) is the canonical *authoring* input for
  parametric measures. A deterministic **codegen** compiles `rule:` (+ the existing `bindings:` codes/value
  sets) → CQL → ELM via the existing pipeline.
- Codegen is **opt-in per measure**: a measure with no `rule:` block keeps its hand-written `.cql`
  (eCQM/complex measures stay hand-authored; E14 import/diff is unaffected).
- The Rule Builder UI (E11.2) is a form over the `rule:` block. This answers Doug's "is CQL or YAML
  canonical?": **CQL is canonical for logic; rule-params are the canonical authoring surface that generates
  that CQL** — no second execution path.

## 4. Architecture

### 4.1 The `rule:` schema (extends the measure YAML)

A discriminated union by `rule.type`, reusing the existing `bindings:` (enrollment/waiver/event/refusal
codes + value sets). Added to a measure's `*.yaml`:

```yaml
# series-completion (PERMANENT) — mmr / varicella / hepatitis_b
rule:
  type: series-completion
  requiredDoses: 2
```
```yaml
# windowed-recency (RECURRING) — audiogram / hazwoper / tb_surveillance …
rule:
  type: windowed-recency
  windowDays: 365
  dueSoonDays: 30        # COMPLIANT when daysSince ≤ (windowDays − dueSoonDays); DUE_SOON in the band
```

The codes (`event`, `enrollment`, `waiver`, `refusal`) and `complianceClass`/`complianceWindowDays` already
live in `bindings:` — codegen reads them, so the `rule:` block carries only the *thresholds/shape*.

### 4.2 Codegen module

`backend-ts/src/engine/cql/codegen/` — pure, deterministic, no I/O:
- `generateCql(input: { libraryName, version, rule, bindings }): string` — dispatches on `rule.type` to a
  template that reproduces the existing CQL define structure exactly, parameterized by the bindings + rule
  thresholds. Two templates:
  - **series-completion** → the `Enrolled` / `Has Contraindication` / `Refused` / `Dose Count` /
    `Series Complete` (`Dose Count >= {requiredDoses}`) / `Excluded` / `Initial Population` /
    `Outcome Status` (EXCLUDED → COMPLIANT → MISSING_DATA) defines — matching `mmr.cql` verbatim modulo the
    code/value-set/dose params.
  - **windowed-recency** → the enrollment/waiver/recency-date/days-since defines + the COMPLIANT/DUE_SOON/
    OVERDUE/MISSING_DATA/EXCLUDED `Outcome Status` ladder — matching `audiogram.cql` verbatim modulo params.
- `libraryName`/`version` come from the measure registry (`MEASURES[id].library`, e.g. `MmrSeries 1.0.0`)
  so the generated `library …` header matches the hand-written one.

### 4.3 Build integration (no cutover)

- A new script `backend-ts/scripts/gen-cql.mjs`: for each `measures/*.yaml` that declares a `rule:` block,
  generate `backend-ts/measures/generated/<id>.cql`. (Separate dir — the hand-written `measures/<id>.cql`
  remains the build's source of truth this sub-project.)
- The existing `scripts/compile-measures.mjs` and `scripts/gen-measure-bindings.mjs` are **unchanged**; the
  build still compiles the hand-written `.cql` to ELM. The generated CQL is produced for the parity proof
  only — a later increment flips the build to consume `generated/` once it's trusted.

### 4.4 Outcome-parity proof (the de-risk)

The generated CQL uses **canonical define names** (it need not reproduce each measure's idiosyncratic
hand-written define names). For the series shape the canonical names already match the hand-written ones
(`Enrolled` / `Has Contraindication` / `Refused` / `Dose Count` / `Series Complete` / `Excluded` /
`Initial Population` / `Outcome Status`); for the windowed shape the canonical names are
`Enrolled` / `Excluded` / `Most Recent Event Date` / `Days Since Last Event` / `Compliant` / `Due Soon` /
`Overdue` / `Missing Data` / `Initial Population` / `Outcome Status` — chosen to satisfy the roster's
`deriveWhyFlagged` regexes (`/^most recent .*date$/i`, `/^days since/i`, waiver/contraindication) so the
existing roster/evidence surfaces keep working.

The parity basis is **`Outcome Status`** — the only compliance authority (ADR-008). A test
(`backend-ts/src/engine/cql/codegen/codegen-parity.test.ts`) that, for each migrated measure:
1. reads the measure's `rule:` + `bindings:` from YAML, runs `generateCql`, asserts the generated CQL text
   **equals** the committed `measures/generated/<id>.cql` (snapshot — the generator is deterministic);
2. translates the generated CQL → ELM (the `@cqframework/cql` path the build's `compile-measures.mjs` uses)
   and evaluates it over the existing synthetic scenarios, asserting its **`Outcome Status`** equals the
   **hand-written** measure's `Outcome Status` (the committed ELM) for **every** scenario — i.e. **generated
   ≡ hand-written on the compliance result**. Any drift fails CI. (Self-contained: compares generated vs
   hand-written, both in Node — no dependence on the retired Java golden, so the E10 series measures are
   covered too.)

This proves codegen produces the *same compliance outcome* as the trusted hand-written CQL before any UI
(E11.2) emits these params.

## 5. Scope — measures migrated in E11.1

- **series-completion:** `mmr`, `varicella`, `hepatitis_b_vaccination_series` (the vaccine core, vamsi6) —
  structurally identical, code-scoped; the template reproduces them exactly.
- **windowed-recency:** `audiogram`, `hypertension`, `cholesterol_ldl` — the three **code-scoped, uniform**
  windowed measures (inline code-filter enrollment/waiver). They differ only in codes/value-sets + the
  DUE_SOON band (`compliantMaxDays`), so one parameterized template covers all three.

**Deliberately excluded this sub-project:** `hazwoper` + `tb_surveillance` use the **legacy non-code-scoped**
pattern (`exists([Condition])` enrollment, `Count([Condition]) > 1` exemption) — generating code-scoped CQL
for them would change behavior, so they need a separate migration to the inline-code pattern first (tracked,
not in E11.1). Also left hand-written/untouched: adult_immunization (10y), flu (seasonal), cms122
(value-based), cms125, the eCQM catalog. Codegen extends to these as the Rule Builder needs them.

## 6. Error / edge handling

- `generateCql` validates the `rule` discriminator; an unknown `rule.type` throws (build-time, surfaced by
  `gen-cql.mjs` / the test).
- A measure with a `rule:` block whose generated CQL diverges from golden **fails the parity test** (the
  whole point — no silent drift).
- Measures without a `rule:` block are skipped by `gen-cql.mjs` (opt-in).

## 7. Testing

- **Codegen unit:** `generateCql` for each shape produces the expected CQL (snapshot vs the committed
  `generated/<id>.cql`); unknown `rule.type` throws.
- **Outcome parity:** generated-CQL ELM's `Outcome Status` equals the hand-written measure's `Outcome
  Status` across all synthetic scenarios for the 6 migrated measures (the compliance authority; §4.4).
- **Schema:** the YAML loader accepts the new optional `rule:` block (existing measures without it still
  load).
- **Full gate:** backend `tsc --noEmit` + `node --test` (incl. the existing 40/40 golden harness stays
  green); the spike `compare-all` parity is unaffected (hand-written path unchanged).

## 8. Guardrails

- **ADR-008 holds** — CQL `Outcome Status` stays the sole compliance authority; codegen only *produces* CQL,
  it doesn't introduce a second decision path.
- **No cutover, no destabilization** — hand-written `.cql` remains the build source; generated CQL is proven
  equivalent alongside it.
- **No schema/DDL** (rule-params are build-time YAML), **no new runtime dependencies** (codegen is a pure TS
  module + a build script reusing the existing translate/compile path). Owner-gate not triggered.

## 9. File structure

- Create: `backend-ts/src/engine/cql/codegen/generate-cql.ts` (+ shape templates), `…/codegen.test.ts`,
  `…/codegen-parity.test.ts`; `backend-ts/scripts/gen-cql.mjs`; `backend-ts/measures/generated/<id>.cql` ×6.
- Modify: the 6 measures' `backend-ts/measures/<id>.yaml` (add `rule:`); the YAML type/loader to accept
  `rule?:`; `docs/DECISIONS.md` (ADR-015); `docs/ARCHITECTURE.md` (engine §3 codegen note); `docs/JOURNAL.md`.

## 10. References

- Epic E11 #183; ADR-006 (YAML bindings), ADR-008 (CQL authoritative), ADR-014 (CQL→SQL, deferred) →
  this is **ADR-015**.
- Existing CQL: `backend-ts/measures/mmr.cql` (series-completion exemplar), `audiogram.cql`
  (windowed-recency exemplar); golden harness `backend-ts/spike/compare-all.mjs` +
  `spike/synthetic/_java_golden.json`; build `scripts/compile-measures.mjs` + `gen-measure-bindings.mjs`.
- Follow-ons: **E11.2** Rule Builder UI (form → `rule:` YAML; vamsi6/7), **E11.3** segments/risk-groups
  (vamsi8; the roster GROUPS column + N/A scoping).
