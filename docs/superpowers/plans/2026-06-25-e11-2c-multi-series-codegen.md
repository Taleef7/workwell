# E11.2c — Multi-alternative-series Codegen + Live Hep B Repoint Implementation Plan (#183)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an additive, back-compatible codegen capability for multi-alternative vaccine series (multi-CVX code sets + per-alternative minimum dose intervals), expose it in the Rule Builder, and **repoint the live `hepatitis_b_vaccination_series` measure** to the real Heplisav-B-vs-traditional logic — with the E10 roster still rendering correctly.

**Architecture:** Two PRs. **PR-1** = codegen + Rule Builder UI (no live measure change; proven by behavioral goldens). **PR-2** = repoint live Hep B (CQL/ELM, alternative-aware synthetic dose model, value set, parity fixtures, advisory consumers, docs). CQL stays canonical (ADR-015); `Outcome Status` from the single engine path is the sole compliance authority (ADR-008).

**Tech Stack:** backend-ts (`@mieweb/cloud`, `node --test`, `@cqframework/cql` in-process compile); frontend (Next.js, Vitest + RTL).

**Design:** `docs/superpowers/specs/2026-06-25-e11-2c-multi-series-codegen-design.md`.

---

# PR-1 — Codegen capability + Rule Builder UI (branch `feat/e11-2c-multi-series-codegen`)

## Task 1: Codegen schema + alternatives templates

**Files:**
- Modify: `backend-ts/src/engine/cql/codegen/generate-cql.ts`
- Test: `backend-ts/src/engine/cql/codegen/generate-cql.test.ts`, `backend-ts/src/engine/cql/codegen/generate-cql-extensions.test.ts`

- [ ] **Step 1: Read the current codegen.** Read `generate-cql.ts` in full — note the exact `Rule`/`CodegenBindings` types, the header builder, and the `seriesCompletion(input)` function (how it emits `Enrolled`, `Has Contraindication`, `Refused`, `Has Positive Titer`, `Dose Count`, `Series Complete`, `Excluded`, `Initial Population`, `Outcome Status`). You will extend `seriesCompletion`; leave `windowedRecency` untouched.

- [ ] **Step 2: Extend the types.** Add to `generate-cql.ts`:
```typescript
export interface SeriesAlternative {
  label: string;
  requiredDoses: number;
  minIntervalDays?: number[]; // length requiredDoses-1; absent ⇒ count-only
}
```
Add `alternatives?: SeriesAlternative[];` to the `series-completion` member of `Rule`. Add to `CodegenBindings`:
```typescript
  eventAlternatives?: Array<{ label: string; codes: CodeBinding[] }>;
```

- [ ] **Step 3: Write the failing unit tests** (append to `generate-cql.test.ts`). The helper `gen(rule, bindings)` already exists in that file (find it; it calls `generateCql({library, version, rule, bindings})`); reuse it.
```typescript
test("alternatives: emits a per-alternative Complete define + a union Dose Count, no single Dose Count >= N", () => {
  const cql = gen(
    { type: "series-completion", requiredDoses: 2, alternatives: [
      { label: "Heplisav-B", requiredDoses: 2, minIntervalDays: [28] },
      { label: "Traditional", requiredDoses: 3, minIntervalDays: [28, 56] },
    ] },
    { enrollment: { code: "e", valueSet: "urn:vs:enr" }, waiver: { code: "w", valueSet: "urn:vs:wai" },
      event: { code: "hepb", valueSet: "urn:workwell:vs:hepb-vaccines", type: "immunization" },
      eventAlternatives: [
        { label: "Heplisav-B", codes: [{ code: "189", valueSet: "urn:workwell:vs:hepb-vaccines" }] },
        { label: "Traditional", codes: [{ code: "08", valueSet: "urn:workwell:vs:hepb-vaccines" }, { code: "43", valueSet: "urn:workwell:vs:hepb-vaccines" }] },
      ] }
  );
  assert.match(cql, /define "Heplisav-B Complete":/);
  assert.match(cql, /define "Traditional Complete":/);
  assert.match(cql, /define "Dose Count":/);              // union total kept for the roster
  assert.match(cql, /"Heplisav-B Complete" or "Traditional Complete"/);
  assert.match(cql, /difference in days between .* >= 28/); // interval gate present
  assert.doesNotMatch(cql, /"Dose Count" >= 2/);          // single-code path NOT used when alternatives present
});

test("alternatives absent: series output is unchanged from the single-code path", () => {
  const single = gen({ type: "series-completion", requiredDoses: 2 },
    { enrollment: { code: "e", valueSet: "v" }, waiver: { code: "w", valueSet: "v" }, event: { code: "x", valueSet: "v", type: "immunization" } });
  assert.match(single, /"Dose Count" >= 2/);
  assert.doesNotMatch(single, /Complete":\n  exists/);
});
```

- [ ] **Step 4: Run them, confirm FAIL.** `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts`

- [ ] **Step 5: Implement the alternatives branch in `seriesCompletion`.** When `rule.alternatives?.length` is truthy, build the defines below instead of the single `Dose Count`/`Series Complete`. Validate first: for each alternative there must be a matching `bindings.eventAlternatives` entry by `label` (else `throw new Error(\`series alternative '\${a.label}' has no eventAlternatives codes\`)`); if `a.minIntervalDays` is present its length must equal `a.requiredDoses - 1` (else throw). Emit, for each alternative `a` with codes `cs` (all share `event.valueSet`'s system — use `event.valueSet` as the system, `cs[i].code` as the codes):

```
define "<a.label> Dose Dates":
  [Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = '<event.valueSet>' and (C.code = '<c0>'[ or C.code = '<c1>' ...]))
    return (I.occurrence as FHIR.dateTime)
```
Then `"<a.label> Complete"`: if no `minIntervalDays` → `Count("<a.label> Dose Dates") >= <a.requiredDoses>`. Else an ordered multi-source exists with R = `a.requiredDoses` sources `d0..d{R-1}`:
```
define "<a.label> Complete":
  exists("<a.label> Dose Dates" d0, "<a.label> Dose Dates" d1[, "<a.label> Dose Dates" d2 ...]
    where d0 < d1[ and d1 < d2 ...]
      and difference in days between d0 and d1 >= <interval[0]>[
      and difference in days between d1 and d2 >= <interval[1]> ...])
```
The union **`Dose Count`** (kept for the roster), over every code in every alternative (dedup the codes):
```
define "Dose Count":
  Count([Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = '<event.valueSet>' and (C.code = '<all alt codes OR-joined>')))
```
**`Series Complete`**: `"Enrolled" and not "Has Contraindication" and ( <"<altK> Complete"> joined by " or " [ + " or \"Has Positive Titer\"" when titer enabled ] )`. Keep `Enrolled`/`Has Contraindication`/`Refused`/`Excluded`/`Initial Population`/`Outcome Status` exactly as the single-code path emits them. Use small local helpers (`orCodes(system, codes)` for the `(C.code = 'a' or C.code = 'b')` fragment; `intervalExists(label, R, gaps)` for the multi-source exists) to keep it DRY.

- [ ] **Step 6: Run the unit tests — pass.** `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts`

- [ ] **Step 7: Write the behavioral goldens** (append to `generate-cql-extensions.test.ts`). Reuse that file's existing helpers (`bundle`, `patient`, `condition`, an immunization helper, `evalGen(measureId, rule, bundle)` which generates CQL for `rule`, `compileCql`s it, and evaluates via the engine with the `elm` override). If an immunization-with-date helper isn't present, add one mirroring the `observation` helper: `immz(pid, system, code, dateISO)` → an `Immunization` resource (`status:"completed"`, `vaccineCode.coding:[{system,code}]`, `occurrenceDateTime:dateISO`). Define a reusable Hep B alternatives rule + bindings constant in the test. Scenarios (assert `.outcome`):
```text
- 2 Heplisav (CVX 189) doses ≥28d apart                       → COMPLIANT
- 2 traditional (CVX 08) doses                                 → MISSING_DATA  (needs 3)
- 3 traditional doses spaced 60d (≥28,≥56)                     → COMPLIANT
- 3 traditional doses where dose2→3 gap is 27d (<28… use 27 between two) → MISSING_DATA
- 3 traditional doses with a gap exactly 28d (inclusive boundary)        → COMPLIANT
- 1 Heplisav + 1 traditional (mixed brand, neither alt complete)        → MISSING_DATA
- enrollment + a contraindication condition                   → EXCLUDED
```
(Use `evaluationDate` = a fixed date after the doses; the measure id for codegen-only tests can be any series id whose library name the generator uses — follow the existing extension tests' convention of passing `"mmr"` with an overriding rule.)

- [ ] **Step 8: Run the goldens — pass.** `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql-extensions.test.ts`

- [ ] **Step 9: Regression + typecheck.** `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test src/engine/cql/codegen/codegen-parity.test.ts src/engine/cql/codegen/generate-cql.test.ts src/engine/cql/codegen/generate-cql-extensions.test.ts` — all green (the parity proof unchanged: no measure uses `alternatives` yet).

- [ ] **Step 10: Commit.**
```bash
git add backend-ts/src/engine/cql/codegen/generate-cql.ts backend-ts/src/engine/cql/codegen/generate-cql.test.ts backend-ts/src/engine/cql/codegen/generate-cql-extensions.test.ts
git commit -m "feat(codegen): multi-alternative series + min-interval + multi-CVX (E11.2c, #183)"
```
Append the two trailer lines (Co-Authored-By + Claude-Session) used throughout the repo.

## Task 2: Rule Builder UI — alternatives sub-form

**Files:**
- Modify: `frontend/features/studio/types.ts`, `frontend/features/studio/components/RuleBuilderTab.tsx`
- Test: `frontend/features/studio/components/__tests__/RuleBuilderTab.test.tsx`

- [ ] **Step 1: Mirror the types** in `frontend/features/studio/types.ts`: add `SeriesAlternative` (`{ label: string; requiredDoses: number; minIntervalDays?: number[] }`), add optional `alternatives?: SeriesAlternative[]` to the series member of `RuleParams`, and `eventAlternatives?: Array<{ label: string; codes: RuleCodeBinding[] }>` to `RuleBindings`.

- [ ] **Step 2: Write the failing test** (append to `RuleBuilderTab.test.tsx`):
```tsx
it("alternative-series toggle reveals the alternatives list and emits alternatives on save", async () => {
  const put = vi.fn().mockResolvedValue({ cql: "x", status: "COMPILED", errors: [], warnings: [] });
  // base fixture is series-completion with full single-code bindings; turn on alternatives
  renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put });
  fireEvent.click(screen.getByLabelText(/alternative series/i));
  // a default alternative row appears with label + required doses + codes inputs
  expect(screen.getByLabelText(/alternative 1 label/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/alternative 1 label/i), { target: { value: "Heplisav-B" } });
  fireEvent.change(screen.getByLabelText(/alternative 1 cvx codes/i), { target: { value: "189" } });
  fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
  await waitFor(() => expect(put).toHaveBeenCalledWith("/api/measures/mmr/rule", expect.objectContaining({
    rule: expect.objectContaining({ alternatives: expect.arrayContaining([expect.objectContaining({ label: "Heplisav-B" })]) }),
    bindings: expect.objectContaining({ eventAlternatives: expect.any(Array) }),
  })));
});
```

- [ ] **Step 3: Run it, confirm FAIL.** `cd frontend && npx vitest run features/studio/components/__tests__/RuleBuilderTab.test.tsx`

- [ ] **Step 4: Implement the alternatives sub-form** in `RuleBuilderTab.tsx`. Add (series shape only) an `alternativesOn` boolean state + an `alts` state: `Array<{ label: string; requiredDoses: number; codesText: string; intervalsText: string }>` (default one empty row, hydrated from `measure.rule.alternatives` + `measure.ruleBindings.eventAlternatives` when present → `alternativesOn` true). Render a checkbox `aria-label="Alternative series (multi-brand)"`; when on, render the single requiredDoses/event-code fields disabled/hidden and an editable list — each row with `aria-label`s `alternative {i+1} label`, `alternative {i+1} required doses`, `alternative {i+1} cvx codes` (comma/space/newline separated), `alternative {i+1} min intervals (days)` (comma separated, optional) + an Add/Remove control. When `alternativesOn`, build `rule.alternatives` (parse codes/intervals; `minIntervalDays` omitted when the intervals field is blank) and `bindings.eventAlternatives` (each alt's codes mapped to `{ code, valueSet: eventCode.valueSet }`), and DROP the single-code `requiredDoses` from the rule object's effect on preview/save. Extend `bindingsComplete`: when `alternativesOn`, require the event value set + each alternative to have a label, ≥1 code, and (if intervals provided) `intervals.length === requiredDoses - 1`; else fall back to today's single-code check.

- [ ] **Step 5: Run the tab tests + typecheck + lint.** `cd frontend && npx vitest run features/studio/components/__tests__/RuleBuilderTab.test.tsx && npx tsc --noEmit && npm run lint` — all pass; only the pre-existing next-font warning. If the debounced-preview effect trips `react-hooks/set-state-in-effect`, use the established deferred `setTimeout(…, 0)` + `cancelled` guard already in that file.

- [ ] **Step 6: Commit.**
```bash
git add frontend/features/studio/types.ts frontend/features/studio/components/RuleBuilderTab.tsx frontend/features/studio/components/__tests__/RuleBuilderTab.test.tsx
git commit -m "feat(studio): Rule Builder alternative-series sub-form (multi-CVX + intervals) (E11.2c, #183)"
```
Append the two trailer lines.

## Task 3: PR-1 docs + verification + open PR

- [ ] **Step 1: Docs.** `docs/DECISIONS.md` — append an E11.2c note under ADR-015 (codegen now supports multi-alternative series + min-interval + multi-CVX; additive/back-compat; CQL canonical). `docs/ARCHITECTURE.md` — extend the `engine.cql.codegen` description (the `generate-cql.ts` line) to mention the alternatives capability. `docs/JOURNAL.md` — dated `## 2026-06-25 — E11.2c PR-1: multi-alternative-series codegen + Rule Builder` entry (capability only; live repoint follows in PR-2).
- [ ] **Step 2: Full gate.** Backend `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"`; frontend `cd frontend && npx vitest run && npm run lint && npm run build`. All green.
- [ ] **Step 3: Commit docs** (`docs(codegen): multi-alternative series capability (E11.2c PR-1, #183)` + trailers), push the branch, open the PR (base `main`) with a body summarizing the capability + that it makes **no live measure change** (the Hep B repoint is the follow-up PR-2).

> **STOP for review.** PR-1 is a self-contained, zero-blast-radius capability. After it is reviewed (whole-branch code review + Codex) and merged, proceed to PR-2 on a fresh branch off the updated `main`.

---

# PR-2 — Repoint live Hep B (branch `feat/e11-2c-repoint-hepb`, off merged `main`)

## Task 4: Value set + measure binding (Hep B rule → alternatives)

**Files:**
- Modify: `backend-ts/src/measure/value-set-seed.ts`, `backend-ts/measures/hepatitis_b.yaml`

- [ ] **Step 1: Value set.** In `value-set-seed.ts`, the `urn:workwell:vs:hepb-vaccines` set (id `c0000001-…-008`) currently lists `hepb-vaccine`, `08`, `43`, `189`. Add the remaining traditional-schedule CVX: `c("44", "Hep B, dialysis", CVX)` and `c("45", "Hep B, unspecified", CVX)`. Leave the local `hepb-vaccine` code in place (back-compat for any not-yet-repointed bundle).
- [ ] **Step 2: YAML rule.** Edit `measures/hepatitis_b.yaml`'s `rule:` block to:
```yaml
rule:
  type: series-completion
  requiredDoses: 2
  alternatives:
    - { label: "Heplisav-B", requiredDoses: 2, minIntervalDays: [28] }
    - { label: "Traditional", requiredDoses: 3, minIntervalDays: [28, 56] }
```
and add to `bindings:` an `eventAlternatives:` parallel list:
```yaml
  eventAlternatives:
    - { label: "Heplisav-B", codes: [{ code: "189", valueSet: "urn:workwell:vs:hepb-vaccines" }] }
    - { label: "Traditional", codes: [
        { code: "08", valueSet: "urn:workwell:vs:hepb-vaccines" },
        { code: "43", valueSet: "urn:workwell:vs:hepb-vaccines" },
        { code: "44", valueSet: "urn:workwell:vs:hepb-vaccines" },
        { code: "45", valueSet: "urn:workwell:vs:hepb-vaccines" } ] }
```
Keep `event:`, `series: { requiredDoses: 2 }`, `complianceClass: PERMANENT` as-is (`event` stays the union value set; `series.requiredDoses` 2 drives the roster IN_PROGRESS label). **Confirm the YAML loader (`backend-ts/src/engine/yaml/…`) carries `rule.alternatives` + `bindings.eventAlternatives` through** — read the loader/schema; if it strips unknown keys, extend its types so both survive into the `Rule`/`CodegenBindings` it produces (mirror how it already carries `series`/`refusal`/`titer`). Add/extend a loader unit test asserting the Hep B binding exposes `alternatives`.

- [ ] **Step 3: Verify the loader.** `cd backend-ts && node --import tsx --test src/engine/yaml/*.test.ts` (or the YAML provider test) — green, Hep B alternatives present.

## Task 5: Regenerate Hep B CQL + ELM + bindings (EOL-disciplined)

**Files:**
- Modify: `backend-ts/measures/hepatitis_b.cql`; regenerate `backend-ts/measures/generated/hepatitis_b_vaccination_series.cql`, the Hep B `*.elm.json`, `backend-ts/src/engine/synthetic/measure-bindings.ts`

- [ ] **Step 1: Rewrite the hand-written `measures/hepatitis_b.cql`** to the alternatives logic — make it `Outcome Status`-equivalent to what `generateCql` now produces for the Hep B rule (the per-alternative `Heplisav-B Complete` count-+-interval define, `Traditional Complete`, the union `Dose Count`, `Series Complete = Enrolled and not Has Contraindication and (Heplisav-B Complete or Traditional Complete)`). Use the generated artifact as the reference: run `node -e` or a scratch test to print `generateCql` for the Hep B rule and copy its body into the hand-written file (adjusting only the `library HepatitisBSeries version '1.0.0'` header which already matches).
- [ ] **Step 2: Regenerate artifacts.** `cd backend-ts && pnpm compile-measures` (runs `gen-measure-bindings.mjs` + `compile-measures.mjs`). This rewrites the generated `.cql`, the `.elm.json`s, and `measure-bindings.ts`.
- [ ] **Step 3: EOL discipline — commit only Hep B's churn.** `git status` will likely show EOL-only diffs on many generated files. Detect real changes: `git diff --stat --ignore-all-space` shows files with non-whitespace changes (expect: the Hep B generated `.cql`, the Hep B `.elm.json`, and the Hep B row in `measure-bindings.ts`). Revert EOL-only churn on every OTHER generated file: `git checkout -- <those files>`. Verify `git diff --stat` now lists only Hep B artifacts + the hand-written `hepatitis_b.cql`. If `measure-bindings.ts` shows whole-file EOL flip with only the Hep B row changed, hand-edit just the Hep B row instead (per the repo's established practice) and `git checkout -- src/engine/synthetic/measure-bindings.ts` first.
- [ ] **Step 4: Verify codegen parity.** `cd backend-ts && node --import tsx --test src/engine/cql/codegen/codegen-parity.test.ts` — **this will fail until Task 6 updates the fixtures** (the current fixtures stamp the legacy `hepb-vaccine` code which the new Dose Count union still counts, but the new `*-Complete` interval/count logic needs real CVX + spacing). Note the failure and proceed to Task 6; re-run after.

## Task 6: Repoint synthetic dose model + parity fixtures

**Files:**
- Modify: `backend-ts/src/engine/synthetic/exam-config.ts`, `backend-ts/src/engine/synthetic/fhir-bundle-builder.ts`, `backend-ts/spike/synthetic/hepatitis_b_vaccination_series/*.json`
- Test: `backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts`

- [ ] **Step 1: Make the dose generator alternative-aware.** In `exam-config.ts` `deriveExamConfig(binding, target)` (and the `ExamConfig` type), when `binding.alternatives?.length` (the synthetic binding carries the YAML alternatives — confirm `gen-measure-bindings.mjs` includes them; if not, extend that generator to emit `alternatives` + `eventAlternatives` into `measure-bindings.ts`), pick one alternative deterministically — e.g. `binding.alternatives[hash(subjectId+rateKey) % binding.alternatives.length]`. Set `requiredDoses`/`doseCount` from the **chosen** alternative (COMPLIANT → `alt.requiredDoses`; partial/OVERDUE → `alt.requiredDoses-1`; MISSING/EXCLUDED → 0), and carry the chosen alt's first CVX code + its `minIntervalDays` onto the `ExamConfig` (new optional fields `eventCodeOverride?: string`, `doseIntervalDays?: number[]`). In `fhir-bundle-builder.ts`, when those overrides are present, stamp the immunization `vaccineCode.coding` with `eventCodeOverride` (system = `event.valueSet`) and space consecutive doses by `max(60, the interval for that gap)` so a COMPLIANT employee always satisfies the chosen alt's intervals. No `alternatives` ⇒ unchanged behavior. Thread `subjectId` into `deriveExamConfig` if not already available (read how it's called from the run pipeline).
- [ ] **Step 2: Repoint the parity fixtures** `spike/synthetic/hepatitis_b_vaccination_series/*.json`:
  - `present_recent.json` → 2 Immunizations, CVX `189` (Heplisav), ≥28d apart, recent → COMPLIANT.
  - `present_old.json` → 3 Immunizations, CVX `08` (Traditional), spaced ≥28/≥56d, old dates → COMPLIANT.
  - `missing.json` → enrollment only (unchanged) → MISSING_DATA.
  - `excluded.json` → doses (any CVX) + contraindication (unchanged shape, update the dose codes to `189`) → EXCLUDED.
- [ ] **Step 3: Re-run codegen parity + bundle golden.** `cd backend-ts && node --import tsx --test src/engine/cql/codegen/codegen-parity.test.ts src/engine/synthetic/fhir-bundle-builder.test.ts` — both green (generated ≡ hand-written on the repointed fixtures; the existing Hep B COMPLIANT/partial/missing/excluded rows still hold via the alternative-aware generator). Fix the generator/fixtures until green.
- [ ] **Step 4: Typecheck + full synthetic/engine tests.** `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/engine/**/*.test.ts"` — green.

## Task 7: Roster verification + advisory consumers

**Files:**
- Modify: `backend-ts/src/engine/immunization/immunization-forecast.ts`, `backend-ts/src/order/order-catalog.ts`, `backend-ts/src/measure/measure-catalog.ts`
- Test: `backend-ts/src/compliance/roster-vocabulary.test.ts` (or wherever `deriveCell` is tested)

- [ ] **Step 1: Roster assertion.** Add a `deriveCell` test for repointed Hep B: evidence with `Dose Count` = 2 + `Outcome Status` COMPLIANT → `{ status: "COMPLIANT", method: "2 valid dose(s)" }`; `Dose Count` = 1 + canonical MISSING_DATA → `{ status: "IN_PROGRESS", method: "1 of 2 doses on file" }`; `Dose Count` = 0 → `MISSING_DATA "No doses on file"`. (No `deriveCell` code change expected — this pins the behavior.)
- [ ] **Step 2: Advisory forecaster.** In `immunization-forecast.ts`, update the Hep B series model so `HEPB_DOSES_REQUIRED`/synthetic history reflect the 2-or-3 reality (e.g. a 2-dose Heplisav default). Advisory only — must not affect `Outcome Status`. Update/keep its unit test green.
- [ ] **Step 3: Advisory order.** In `order-catalog.ts`, change the Hep B proposed order code from CVX `08` to `189` (modern Heplisav default). Update any order test referencing it.
- [ ] **Step 4: Catalog spec text.** In `measure-catalog.ts`, update the Hep B `spec.description` — drop the "Heplisav-vs-traditional…deferred to E11" sentence; describe it as a multi-alternative series (Heplisav-B 2-dose **or** traditional 3-dose with ACIP intervals).
- [ ] **Step 5: Verify.** `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"` — all green.

## Task 8: PR-2 docs + full verification

**Files:** `docs/MEASURES.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/JOURNAL.md`

- [ ] **Step 1: `docs/MEASURES.md`** — update the Hep B rows (Category 2 catalog line + the Category 3c permanent-panel table + the "Heplisav-vs-traditional…deferred to E11" note) to describe the now-live multi-alternative series (Heplisav-B 2-dose CVX 189 OR traditional 3-dose CVX 08/43/44/45, ACIP min-intervals; titer still deferred).
- [ ] **Step 2: `docs/ARCHITECTURE.md` + `docs/DATA_MODEL.md`** — note the codegen alternatives capability is now used by live Hep B; **no schema change** (value-set + synthetic edits are seed/app data). `docs/JOURNAL.md` — dated `## 2026-06-25 — E11.2c PR-2: live Hep B repointed to Heplisav-vs-traditional` entry (call out that seeded Hep B outcomes + roster cells now reflect the real alternatives; reversible by reverting the PR).
- [ ] **Step 2b: Smoke the live data path.** `cd backend-ts && pnpm evaluate --patient ./spike/synthetic/hepatitis_b_vaccination_series/present_recent.json --measure hepatitis_b_vaccination_series --date 2026-06-25 --pretty` → outcome COMPLIANT; repeat for `missing.json` → MISSING_DATA. (Confirms the runtime ELM, not just tests.)
- [ ] **Step 3: Full gate + push + PR.** Backend `tsc` + `node --test "src/**/*.test.ts"`; frontend `vitest` + `lint` + `build` (frontend unchanged in PR-2, but run it). Commit docs (`docs(measures): live Hep B → Heplisav-vs-traditional multi-series (E11.2c PR-2, #183)` + trailers), push `feat/e11-2c-repoint-hepb`, open the PR (base `main`) noting the live behavior change + reversibility.

## Task 9: Reviews + merge (both PRs)

- [ ] For EACH PR: a whole-branch `superpowers:code-reviewer` pass (spec compliance + correctness + ADR-008/no-DDL guardrails + EOL cleanliness via `git diff --stat`), fold in any Critical/Important findings, address Codex auto-review comments, then merge (squash/merge per repo convention) and delete the branch (local + remote) on the user's go-ahead. PR-2 branches off the merged PR-1.

---

## Self-Review

**1. Spec coverage:** §3.1 schema → Task 1.2; §3.2 templates (per-alt Dose Dates/Complete, union Dose Count, Series Complete OR, back-compat) → Task 1.5 + unit/golden tests 1.3/1.7; §3.3 Rule Builder → Task 2; §3.4 repoint table — value set → 4.1, YAML rule → 4.2, hand CQL+ELM regen → Task 5, synthetic model → 6.1, fixtures → 6.2, forecaster/order/catalog → Task 7, roster compat → 7.1; §5 EOL → Task 5.3; §6 testing → Tasks 1/2/6/7; §7 guardrails (ADR-008, no-DDL, schema-owner gate) → honored, docs Task 8.

**2. Placeholder scan:** the CQL target strings, schema, and synthetic logic are specified concretely. Two deliberate "read the current X then extend" steps (1.1 the `seriesCompletion` body; 4.2 the YAML loader) are precise verification steps because those exact sources weren't quoted verbatim into this plan — each names the file, the keys to carry, and the assertion to add, not vague logic. Task 5.4's expected failure is intentional (fixtures land in Task 6).

**3. Type consistency:** `SeriesAlternative` + `eventAlternatives` (backend, Task 1.2) are mirrored byte-shape in the frontend (`RuleParams.alternatives`, `RuleBindings.eventAlternatives`, Task 2.1); the YAML `rule.alternatives`/`bindings.eventAlternatives` (4.2) deserialize into those same backend types (loader check 4.2/4.3); the synthetic `measure-bindings.ts` carries `alternatives`/`eventAlternatives` (6.1) consumed by `deriveExamConfig`; the generated CQL's `Dose Count` define name is the contract the roster `deriveCell` reads (7.1). The Rule Builder's emitted `{rule:{alternatives}, bindings:{eventAlternatives}}` (2.4) is exactly what the E11.2b preview/save endpoints already accept (no backend route change needed).
