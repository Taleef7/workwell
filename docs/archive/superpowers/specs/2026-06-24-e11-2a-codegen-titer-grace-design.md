# E11.2a — Codegen: titer + grace + declination (Design)

Date: 2026-06-24
Status: Approved (design)
Author: Taleef (with Claude)
Epic: E11 (#183) — sub-project 2a (codegen extensions; gates the E11.2b Rule Builder UI)

## 1. Context

E11.1 (ADR-015, merged) established **CQL-canonical codegen**: a measure's `rule:` params compile to CQL via
`backend-ts/src/engine/cql/codegen/generate-cql.ts`, with two shapes (`series-completion`,
`windowed-recency`) proven `Outcome Status`-equivalent to the hand-written CQL. E11.2 adds the **Rule
Builder UI** (vamsi6/7). The UW WebChart Rule Builder's **"Compliance paths & timing"** group —
**allow-positive-titer**, **allow-declination**, **grace-period (days)** — applies broadly and must exist in
codegen before the form can emit it. **This sub-project (E11.2a) extends the codegen with those three; the
Rule Builder UI is E11.2b.** The vaccine-specific multi-alternative-series with min-interval validation +
multi-CVX (Hep B Heplisav-vs-traditional, vamsi6) is the hardest clinical-CQL part and is **deferred** to a
later increment.

## 2. Goal / non-goals

**Goal:** Three additive, back-compatible codegen capabilities — **grace** (windowed), **titer** (series),
**declination** (both) — each validated by behavioral golden scenarios (asserted `Outcome Status`). All
defaults reproduce E11.1 output exactly, so the existing parity tests still pass unchanged.

**Non-goals:** the Rule Builder UI (E11.2b); multi-alternative-series + min-interval/per-dose-month
validation + multi-CVX (deferred); LOINC-bound real titer thresholds (the synthetic model uses a single
value threshold); any schema change.

## 3. Schema additions (additive, back-compatible)

In `generate-cql.ts`, extend the `Rule` union + `CodegenBindings` (all new fields optional; absent ⇒ E11.1
behavior):

```typescript
export type Rule =
  | { type: "series-completion"; requiredDoses: number; allowPositiveTiter?: boolean }
  | { type: "windowed-recency"; windowDays: number; dueSoonDays: number; gracePeriodDays?: number };

export interface CodegenBindings {
  enrollment: CodeBinding;
  waiver: CodeBinding;
  event: CodeBinding & { type: "procedure" | "immunization" | "observation" };
  refusal?: CodeBinding;
  titer?: { code: string; valueSet: string; minValue: number }; // series titer Observation
}
```

## 4. Codegen changes (the three capabilities)

### 4.1 Grace (windowed-recency + `gracePeriodDays`)

`overdueThreshold = windowDays + (gracePeriodDays ?? 0)`. The Due-Soon band extends through grace; OVERDUE
only past it (matches vamsi7: "days past expiry before Due escalates to Overdue"). compliantMax is
unchanged (`windowDays - dueSoonDays`). When `gracePeriodDays` is absent/0, `overdueThreshold = windowDays`
— identical to E11.1.

```text
define "Due Soon":  … "Days Since Last Event" > {compliantMax} and "Days Since Last Event" <= {overdueThreshold}
define "Overdue":   … "Days Since Last Event" > {overdueThreshold}
```

### 4.2 Titer (series-completion + `allowPositiveTiter` + `bindings.titer`)

When `allowPositiveTiter === true` **and** `bindings.titer` is present, emit a `Has Positive Titer` define
(Observation with the titer code, value ≥ `minValue`) and OR it into `Series Complete`. Otherwise the
output is identical to E11.1. Observation pattern matches cms122 (`(O.value as FHIR.Quantity).value`).

```text
define "Has Positive Titer":
  exists([Observation] O
    where exists(O.code.coding C where C.system = '{titer.valueSet}' and C.code = '{titer.code}')
      and (O.value as FHIR.Quantity).value >= {titer.minValue})

define "Series Complete":
  "Enrolled" and not "Has Contraindication" and ("Dose Count" >= {requiredDoses} or "Has Positive Titer")
```

### 4.3 Declination (`bindings.refusal` present → emit `Refused`)

The series template already emits `Refused` when `bindings.refusal` is present (E11.1). Extend the
**windowed** template to do the same: when `bindings.refusal` is present, emit a `Refused` define. `Refused`
never changes `Outcome Status` (the canonical bucket); it is read by the roster's `deriveCell` to show the
**DECLINED** display state + keep the case open (E10.5). The Rule Builder's "allow patient declination =
Yes" maps to including the refusal binding.

## 5. Validation — behavioral golden scenarios

No hand-written CQL exists for these shapes, so validation is **behavioral**: generate the CQL, translate →
ELM in-process (`compileCql`), evaluate over **inline synthetic bundles**, and assert the exact resulting
`Outcome Status` (and the `Refused`/`Has Positive Titer` defines where relevant). New test
`generate-cql-extensions.test.ts`:

- **Grace:** windowed `{windowDays:365, dueSoonDays:30, gracePeriodDays:30}` (overdueThreshold 395). An exam
  **380 days** old → **DUE_SOON** (inside grace); the *same* bundle with `gracePeriodDays:0` → **OVERDUE** —
  proving grace shifts the boundary. An exam **400 days** old → **OVERDUE** even with grace.
- **Titer:** series `{requiredDoses:2, allowPositiveTiter:true}` + titer binding (`minValue:10`). Bundle with
  **0 doses + a titer Observation value 12** → **COMPLIANT**; **0 doses + titer value 8** (< 10) →
  **MISSING_DATA**; **1 dose + no titer** → **MISSING_DATA**. With `allowPositiveTiter:false`, the value-12
  titer bundle → **MISSING_DATA** (titer ignored).
- **Declination:** windowed with a `refusal` binding + a refusal Condition in the bundle and no exam →
  `Outcome Status` = **MISSING_DATA** (unchanged) **and** the `Refused` define is **true** (so the roster
  shows DECLINED).
- **Back-compat:** a `generate-cql.test.ts` assertion that omitting the new fields yields output byte-equal
  to the E11.1 templates (so the existing `codegen-parity.test.ts` 6×4 + the DUE_SOON/partial cases stay
  green unchanged).

## 6. Testing

- Unit (`generate-cql.test.ts`): the new `Has Positive Titer` define appears only when titer is enabled; the
  grace `overdueThreshold` string is correct for a non-default grace; the windowed `Refused` define appears
  only with a refusal binding; defaults reproduce E11.1.
- Behavioral (`generate-cql-extensions.test.ts`): §5 scenarios.
- Regression: the existing `codegen-parity.test.ts` + `generate-cql.test.ts` stay green (the 6 migrated
  measures have no grace/titer → unchanged output).
- Full gate: backend `tsc --noEmit` + `node --test "src/**/*.test.ts"`.

## 7. Guardrails

- **ADR-008 holds** — codegen only *produces* CQL; `Outcome Status` from the single engine path is
  authoritative. Titer is an OR into the COMPLIANT path (a real clinical immunity rule), not an override.
- **Additive + back-compatible** — every new field is optional; absent ⇒ identical to E11.1; the existing
  parity proof is unaffected.
- **No schema/DDL, no new runtime deps.** Reuses the E11.1 codegen module + the `compileCql`/engine path.

## 8. File structure

- Modify: `backend-ts/src/engine/cql/codegen/generate-cql.ts` (schema + 3 capabilities);
  `backend-ts/src/engine/cql/codegen/generate-cql.test.ts` (unit additions).
- Create: `backend-ts/src/engine/cql/codegen/generate-cql-extensions.test.ts` (behavioral goldens).
- Modify docs: `docs/DECISIONS.md` (extend ADR-015 with an E11.2a note), `docs/ARCHITECTURE.md` (codegen
  note), `docs/JOURNAL.md`.

## 9. References

- E11.1: `docs/superpowers/specs/2026-06-24-e11-1-rule-codegen-design.md`, ADR-015, `generate-cql.ts`,
  `codegen-parity.test.ts`.
- Observation/value pattern: `backend-ts/measures/cms122.cql` + `spike/synthetic/cms122/*.json`.
- vamsi6/7 (`docs/vision doc screenshots/`): the "Compliance paths & timing" group (titer/declination/grace)
  is E11.2a; the Hep B multi-series/intervals/multi-CVX is deferred.
- Follow-ons: **E11.2b** Rule Builder UI (Studio tab → form → preview → save); later: multi-series + intervals.
