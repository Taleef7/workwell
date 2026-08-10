# E11.2c — Multi-alternative-series + min-interval + multi-CVX (Design)

Date: 2026-06-25
Status: Approved (design) — scope: **also repoint live Hep B**
Author: Taleef (with Claude)
Epic: E11 (#183) — sub-project 2c (the deferred hardest clinical-CQL piece). Closes the codegen side of
the epic's "per-vaccine: dose counts, series intervals, CVX codes" acceptance (vamsi6).

## 1. Context

E11.1 (ADR-015) made `series-completion` params compile to CQL; E11.2a added titer/grace/declination;
E11.2b shipped the Rule Builder UI. All three assume a **single CVX code** and `Dose Count >= N`. Real
Hepatitis B is an **OR of alternative series** — **Heplisav-B** (2 doses, CVX 189) **or** **traditional**
(3 doses, CVX 08/43/44/45) — each with ACIP **minimum dose intervals** (traditional dose1→2 ≥ 28d,
dose2→3 ≥ 56d; Heplisav dose1→2 ≥ 28d). This was explicitly deferred through E11.2a/2b as "the hardest
clinical-CQL part." E11.2c builds it **and repoints the live `hepatitis_b_vaccination_series` measure** to
the real Heplisav-vs-traditional logic (user-approved scope).

## 2. Goal / non-goals

**Goal:** (a) an additive, back-compatible codegen capability for multi-alternative series with multi-CVX
code sets + per-alternative min-interval validation; (b) the Rule Builder UI to author it; (c) **repoint
live Hep B** end-to-end — generated CQL + runtime ELM, the synthetic dose model, the value set, the parity
fixtures, advisory consumers — with the E10 roster still rendering correctly.

**Non-goals:** changing any *other* measure (MMR/Varicella stay single-code 2-dose); a general N-of-M or
"dose at age" model; real VSAC CVX expansion (the inline-code pattern stays); any DB schema/DDL change
(the value-set + synthetic edits are seed/app data, not DDL). Catch-up/accelerated-schedule clinical
nuance beyond the min-interval gate is out of scope.

## 3. Architecture

Delivered as **two PRs** for reviewable blast radius (CLAUDE.md: many small over few large):

- **PR-1 `E11.2c-codegen`** — the codegen capability + Rule Builder UI. **No live measure change** →
  zero blast radius on the demo; proven by behavioral goldens.
- **PR-2 `E11.2c-repoint`** — repoint live Hep B (CQL/ELM, synthetic data, value set, fixtures, advisory
  consumers, docs). Depends on PR-1.

### 3.1 Codegen schema (additive, back-compatible) — `generate-cql.ts`

```typescript
export type Rule =
  | { type: "series-completion"; requiredDoses: number; allowPositiveTiter?: boolean;
      alternatives?: SeriesAlternative[]; }                       // NEW: absent ⇒ E11.1/2a output exactly
  | { type: "windowed-recency"; windowDays: number; dueSoonDays: number; gracePeriodDays?: number };

export interface SeriesAlternative {
  label: string;                 // human label → CQL define names ("Heplisav-B", "Traditional")
  requiredDoses: number;
  minIntervalDays?: number[];    // consecutive-gap minimums, length requiredDoses-1; absent ⇒ count-only
}

export interface CodegenBindings {
  enrollment: CodeBinding; waiver: CodeBinding;
  event: CodeBinding & { type: "procedure" | "immunization" | "observation" };
  refusal?: CodeBinding;
  titer?: { code: string; valueSet: string; minValue: number };
  eventAlternatives?: Array<{ label: string; codes: CodeBinding[] }>;  // NEW: multi-CVX per alternative,
                                                                       // aligned to Rule.alternatives by label
}
```

Rule (counts/intervals) and bindings (codes) stay split, mirroring the existing pattern. `alternatives`
and `eventAlternatives` correlate **by `label`**.

### 3.2 Codegen templates (series-completion with alternatives)

When `rule.alternatives` is present (and `eventAlternatives` supplies the codes), emit per alternative
`a`, using its code set `codes` (a multi-CVX OR over the same `event.valueSet` system):

```text
define "<a.label> Dose Dates":
  ([Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = '<event.valueSet>' and (C.code = '<c0>' or C.code = '<c1>' ...)))
    I return (I.occurrence as FHIR.dateTime)

// count-only alternative (no minIntervalDays):
define "<a.label> Complete":
  Count("<a.label> Dose Dates") >= <a.requiredDoses>

// interval-validated alternative (minIntervalDays present): an ordered multi-source exists requires
// `requiredDoses` strictly-increasing doses whose consecutive gaps each meet the minimum.
define "<a.label> Complete":
  exists("<a.label> Dose Dates" d0, "<a.label> Dose Dates" d1 [, "<a.label> Dose Dates" d2 ...]
    where d0 < d1 [and d1 < d2 ...]
      and difference in days between d0 and d1 >= <interval[0]>
      [and difference in days between d1 and d2 >= <interval[1]> ...])
```

- **`Dose Count` (kept for the roster)**: a single total over the **union** of all alternative code sets
  (any CVX in any alternative). The E10 roster's `deriveCell` reads a define literally named `"Dose Count"`
  for its *method string* only (the canonical bucket comes from CQL `Outcome Status`), so keeping this
  define name is the compatibility anchor.
- **`Series Complete`**: `"Enrolled" and not "Has Contraindication" and ( "<alt0> Complete" or "<alt1> Complete" [ or "Has Positive Titer" ] )`.
- Everything else (`Enrolled`, `Has Contraindication`, `Refused`, `Excluded`, `Initial Population`,
  `Outcome Status`) is unchanged from E11.1/2a.
- **Back-compat**: `alternatives` absent ⇒ the existing single-code `Dose Count >= requiredDoses` path,
  byte-for-byte. The E11.1 parity proof (`codegen-parity.test.ts`) stays green unchanged.

The ordered multi-source `exists` is mechanical to generate for any `requiredDoses` R (R sources, R-1 gap
clauses). R is small (2–3) for real vaccine series. Distinctness is guaranteed by the strict `<` ordering
(synthetic and real doses have distinct dates). Translatability is **proven in-process** by the behavioral
tests (`compileCql` → evaluate), not assumed.

### 3.3 Rule Builder UI (PR-1) — `RuleBuilderTab.tsx`

Add an **"Alternative series (multi-brand)"** toggle to the series-completion shape. When on, replace the
single requiredDoses + event-code fields with a small editable list of alternatives, each row:
`label`, `requiredDoses`, a comma-or-line list of `CVX codes` (→ `eventAlternatives[].codes` all under the
event value set), and an optional `min intervals (days)` list. The `bindings.event` value set still drives
the system. Emits `rule.alternatives` + `bindings.eventAlternatives`; the live preview + atomic save are
unchanged (they already round-trip whatever `{rule, bindings}` the form builds). Off ⇒ today's single-code
form (back-compat). `bindingsComplete` extends to require each alternative have a label + ≥1 code + value
set; an alternative's interval list, if present, must be length `requiredDoses-1`.

### 3.4 Live Hep B repoint (PR-2)

| Surface | Change |
|---|---|
| `measures/hepatitis_b.yaml` | `rule:` → series-completion with `alternatives` (Heplisav-B 2-dose/[28], Traditional 3-dose/[28,56]); `bindings.eventAlternatives` (Heplisav→[189]; Traditional→[08,43,44,45]). Keep `event.valueSet` = `urn:workwell:vs:hepb-vaccines`. `series.requiredDoses` stays **2** (the roster's IN_PROGRESS label uses the minimum alternative). |
| `measures/hepatitis_b.cql` (hand-written runtime source) | Rewrite to the alternatives logic above so it is `Outcome Status`-equivalent to the generated CQL. Regenerate its ELM + the `measures/generated/...` artifact + `src/engine/synthetic/measure-bindings.ts` via `pnpm compile-measures` (EOL handled — see §5). |
| `src/measure/value-set-seed.ts` | `urn:workwell:vs:hepb-vaccines` already has 08/43/189 + the legacy `hepb-vaccine`; **add CVX 44, 45** (traditional schedule). |
| `src/engine/synthetic/exam-config.ts` + `fhir-bundle-builder.ts` | Make the dose generator **alternative-aware** for a binding that has `alternatives`: pick one alternative deterministically per employee (stable hash), and for a COMPLIANT target emit that alt's `requiredDoses` doses stamped with its **CVX code**, spaced to satisfy its intervals (current 60-day spacing already exceeds Hep B's 28/56). Partial target → `requiredDoses-1`; MISSING/EXCLUDED → 0. Generic + additive (other series unaffected — no `alternatives` ⇒ today's behavior). |
| `spike/synthetic/hepatitis_b_vaccination_series/*.json` | Repoint the parity fixtures to real CVX (e.g. present_recent → 2× CVX 189 Heplisav; present_old → 3× traditional 08 spaced; missing/excluded unchanged) so `codegen-parity` (generated ≡ hand-written) stays valid. |
| `src/engine/immunization/immunization-forecast.ts` (advisory) | `HEPB_DOSES_REQUIRED` reflects the 2-or-3 reality (advisory only; never sets status). |
| `src/order/order-catalog.ts` (advisory) | Hep B proposed order → CVX 189 (modern Heplisav default) instead of 08. |
| `src/measure/measure-catalog.ts` | Update the Hep B catalog `spec.description` (drop "Heplisav-vs-traditional deferred"; describe the alternatives). |

**Roster compatibility:** `deriveCell` (`roster-vocabulary.ts`) reads `Dose Count` + `series.requiredDoses`
only for the *method* string. With `requiredDoses` kept at 2, COMPLIANT shows "N valid dose(s)", partial
shows "1 of 2 doses on file" (approximate for a traditional-3 partial — acceptable display; the canonical
bucket is CQL-authoritative). No `deriveCell` change required; a verification test asserts the roster cell
for a repointed Hep B COMPLIANT/partial/missing employee.

## 4. Data flow (repointed Hep B)

```
deriveExamConfig(binding[hepb], target)
  → picks an alternative per employee (Heplisav|Traditional), sets doseCount + the alt's CVX code/spacing
buildSyntheticBundle → emits Immunizations stamped with CVX 189 (Heplisav) or 08 (Traditional)
CqlExecutionEngine.evaluate(HepatitisBSeries ELM)
  → "<alt> Complete" (count or interval-exists) → "Series Complete" → "Outcome Status"
  → "Dose Count" (total) persisted in evidence for the roster method string
roster deriveCell → COMPLIANT "2 valid dose(s)" | IN_PROGRESS "1 of 2 doses on file" | MISSING_DATA
```

## 5. Error / edge handling + EOL

- Codegen: a missing/mismatched `eventAlternatives` for a declared `alternative` label, or an interval
  array whose length ≠ `requiredDoses-1`, throws in `generateCql` → the route surfaces 400 (preview) /
  persists-with-compile-error (save), matching E11.2b.
- **EOL discipline:** the generated `*.elm.json` / `measures/generated/*.cql` / `measure-bindings.ts` are
  CRLF; `pnpm compile-measures` may flip EOL on Windows. The plan regenerates, then commits **only** Hep B's
  changed artifacts and reverts EOL-only churn on the others (`git diff --ignore-all-space` to detect, `git
  checkout --` to revert). Verified by a clean `git diff --stat` before commit.
- Min-interval boundary is **inclusive** (`>= interval`): a gap exactly equal to the minimum passes.

## 6. Testing

- **Codegen unit** (`generate-cql.test.ts`): the per-alternative `Complete` defines appear; the `Dose
  Count` union define is emitted; absent `alternatives` reproduces E11.1 output exactly.
- **Behavioral goldens** (`generate-cql-extensions.test.ts`, the E11.2a in-process compile+evaluate
  pattern): Heplisav 2 doses → COMPLIANT; traditional 2 → MISSING_DATA (needs 3); traditional 3 spaced
  ≥ intervals → COMPLIANT; traditional 3 with a 27-day gap (min 28) → MISSING_DATA; gap exactly 28 →
  COMPLIANT (inclusive boundary); mixed-brand doses don't cross-count (1 Heplisav + 1 traditional → neither
  alt complete → MISSING_DATA); declination/contraindication still behave.
- **Live parity** (`codegen-parity.test.ts`): generated ≡ hand-written `Outcome Status` for the repointed
  Hep B over its 4 fixtures (still in `MIGRATED`).
- **Synthetic golden** (`fhir-bundle-builder.test.ts`): the existing Hep B COMPLIANT/partial/missing/
  excluded rows stay green after the alternative-aware generator.
- **Roster** (`roster-vocabulary` test): a repointed Hep B COMPLIANT/partial/missing evidence → the right
  cell (`N valid dose(s)` / `1 of 2 doses on file` / `No doses on file`).
- **Rule Builder UI** (`RuleBuilderTab.test.tsx`): the alternatives toggle reveals the alt list; the form
  emits `rule.alternatives` + `bindings.eventAlternatives`; preview/save gated until each alt is complete.
- **Full gate** each PR: backend `tsc --noEmit` + `node --test "src/**/*.test.ts"`; frontend `vitest` +
  `lint` + `build`.

## 7. Guardrails

- **ADR-008 / ADR-015 hold** — codegen only *produces* CQL; the single engine path's `Outcome Status` is
  the sole compliance authority. Alternatives/intervals are an OR/gate into the existing COMPLIANT path,
  not an override.
- **Additive + back-compatible** — every new field optional; absent ⇒ identical to E11.1/2a; the parity
  proof is unaffected.
- **No DB schema/DDL, no new runtime deps.** The value-set seed + synthetic-data edits are app/seed data
  (user-approved repoint), not migrations. Hep B's live compliance semantics change by design (the demo
  roster + seeded outcomes shift to Heplisav-vs-traditional) — called out in the JOURNAL + MEASURES.
- **Schema-owner gate:** no `V0xx` migration is written; if any reviewer believes a column is needed,
  stop and ask Taleef.

## 8. File structure

**PR-1 (codegen + UI):**
- Modify: `backend-ts/src/engine/cql/codegen/generate-cql.ts` (schema + alternatives templates),
  `…/generate-cql.test.ts` (unit), `…/generate-cql-extensions.test.ts` (behavioral goldens);
  `frontend/features/studio/components/RuleBuilderTab.tsx` (+ `__tests__/…`),
  `frontend/features/studio/types.ts` (mirror `SeriesAlternative` + `eventAlternatives`).
- Docs: `docs/DECISIONS.md` (ADR-015 E11.2c note), `docs/ARCHITECTURE.md` (codegen note), `docs/JOURNAL.md`.

**PR-2 (repoint live Hep B):**
- Modify: `backend-ts/measures/hepatitis_b.cql` + `hepatitis_b.yaml`; regenerate
  `backend-ts/measures/generated/hepatitis_b_vaccination_series.cql`, the Hep B `*.elm.json`, and
  `backend-ts/src/engine/synthetic/measure-bindings.ts` (Hep B row only); `…/value-set-seed.ts` (+CVX 44/45);
  `…/synthetic/exam-config.ts` + `fhir-bundle-builder.ts` (alternative-aware); `spike/synthetic/
  hepatitis_b_vaccination_series/*.json`; `…/immunization/immunization-forecast.ts` + `…/order/order-catalog.ts`
  (advisory); `…/measure/measure-catalog.ts` (Hep B spec text).
- Tests: `codegen-parity.test.ts` (fixtures), `fhir-bundle-builder.test.ts` (unchanged rows green),
  a roster-vocabulary assertion.
- Docs: `docs/MEASURES.md` (Hep B alternatives), `docs/ARCHITECTURE.md` / `docs/DATA_MODEL.md` (no-DDL note),
  `docs/JOURNAL.md`.

## 9. References

- E11.1: `…specs/2026-06-24-e11-1-rule-codegen-design.md`, ADR-015. E11.2a:
  `…-e11-2a-codegen-titer-grace-design.md`. E11.2b: `…-e11-2b-rule-builder-ui-design.md`.
- Codegen: `backend-ts/src/engine/cql/codegen/generate-cql.ts`; parity: `codegen-parity.test.ts`.
- Live Hep B path: `measures/hepatitis_b.{cql,yaml}`, `src/engine/synthetic/{exam-config,fhir-bundle-builder,
  measure-bindings}.ts`, `src/measure/value-set-seed.ts`, `src/compliance/roster-vocabulary.ts`.
- Clinical: ACIP Hep B (Heplisav-B 2-dose ≥4wk; traditional 3-dose 0/1/6mo, min intervals 4wk dose1→2,
  8wk dose2→3, 16wk dose1→3). vamsi6 (`docs/vision doc screenshots/`).
- Follow-ons (this epic): **E11.2d** YAML emit + canonical clarification; **E11.3** segments/risk-groups.
