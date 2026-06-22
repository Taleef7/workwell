# E10 Plan 1 — Foundation: measure taxonomy + immunization vaccine panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `complianceClass` (PERMANENT | RECURRING) measure-taxonomy field and three permanent-immunity vaccine measures (MMR, Varicella, Hepatitis B) with the repo's first series-completion CQL pattern, so the later roster grid (Plan 3) has a real Immunizations panel and "once compliant, always compliant" is genuinely modeled.

**Architecture:** All work is in `backend-ts/`. Series-completion lives in CQL (`Count(valid doses) >= N`, no recency) so the engine stays the sole status authority (ADR-008); `complianceClass` + `series` are descriptive binding metadata. The engine still emits only the 5 canonical buckets — IN_PROGRESS/DECLINED/NA are read-model derivations in Plan 3. No schema/DDL (mirrors the E6 `adult_immunization` add: YAML + CQL + synthetic data + idempotent seed).

**Tech Stack:** TypeScript (Node, `tsx`), CQL compiled to ELM via `@cqframework/cql` (`pnpm compile-measures`, JVM-free), `cql-execution` + `cql-exec-fhir` runtime, `node:test` + `node:assert`.

**Covers issues:** [#188 (E10.1)](https://github.com/Taleef7/workwell/issues/188) · [#193 (E10.6)](https://github.com/Taleef7/workwell/issues/193). Spec: `docs/superpowers/specs/2026-06-22-e10-roster-compliance-design.md`.

---

## File map

**Create:**
- `backend-ts/measures/mmr.cql`, `mmr.yaml`
- `backend-ts/measures/varicella.cql`, `varicella.yaml`
- `backend-ts/measures/hepatitis_b.cql`, `hepatitis_b.yaml`
- `backend-ts/spike/synthetic/mmr/{present_recent,present_old,missing,excluded}.json`
- `backend-ts/spike/synthetic/varicella/{present_recent,present_old,missing,excluded}.json`
- `backend-ts/spike/synthetic/hepatitis_b_vaccination_series/{present_recent,present_old,missing,excluded}.json`

**Modify:**
- `backend-ts/scripts/gen-measure-bindings.mjs` — parse `complianceClass` + `series` from YAML; extend the emitted `MeasureBinding` type.
- `backend-ts/measures/*.yaml` (existing 11) — add `complianceClass: RECURRING`.
- `backend-ts/src/engine/synthetic/measure-bindings.ts` — regenerated (do not hand-edit).
- `backend-ts/src/engine/synthetic/exam-config.ts` — series-aware config branch + `doseCount`.
- `backend-ts/src/engine/synthetic/fhir-bundle-builder.ts` — emit N immunization doses.
- `backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts` — add vaccine cases.
- `backend-ts/src/engine/cql/measure-registry.ts` — register mmr / varicella / hepatitis_b_vaccination_series.
- `backend-ts/src/measure/measure-catalog.ts` — add `mmr` + `varicella` Active entries; promote `hepatitis_b_vaccination_series` to Active + COMPILED.
- `backend-ts/src/measure/value-set-seed.ts` — add immunization value sets + links.
- `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts` — per-measure `present_old` expectation for PERMANENT measures.
- `docs/MEASURES.md` — document the 3 measures + the PERMANENT/RECURRING taxonomy.

**Note on Hepatitis B:** `hepatitis_b_vaccination_series` already exists in `measure-catalog.ts` as an **Approved** catalog-only entry (anti-HBs titer exclusion). We **promote** it (Active + runnable CQL) rather than create a duplicate `hep_b`. requiredDoses is modeled as **2** (covers the Heplisav 2-dose series; a 1-dose person is partial/IN_PROGRESS). The Heplisav-vs-traditional distinction and titer-proves-immunity are deferred to E11, consistent with the spec.

---

### Task 1: Add `complianceClass` + `series` to the binding model and generator (E10.1)

**Files:**
- Modify: `backend-ts/scripts/gen-measure-bindings.mjs`
- Modify: every `backend-ts/measures/*.yaml` (add one line)
- Test: `backend-ts/src/engine/synthetic/measure-bindings.taxonomy.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/engine/synthetic/measure-bindings.taxonomy.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";

test("existing recurring measures default to complianceClass RECURRING", () => {
  assert.equal(MEASURE_BINDINGS["audiogram"]!.complianceClass, "RECURRING");
  assert.equal(MEASURE_BINDINGS["adult_immunization"]!.complianceClass, "RECURRING");
});

test("a permanent vaccine measure carries complianceClass PERMANENT + series.requiredDoses", () => {
  const mmr = MEASURE_BINDINGS["mmr"];
  assert.ok(mmr, "mmr binding must exist after gen-measure-bindings");
  assert.equal(mmr.complianceClass, "PERMANENT");
  assert.equal(mmr.series?.requiredDoses, 2);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/measure-bindings.taxonomy.test.ts`
Expected: FAIL (`complianceClass` is `undefined`; `mmr` binding missing). The `mmr` assertion will fail until Task 3; that is expected and re-checked at the end of Task 3.

- [ ] **Step 3: Extend the generator's parser + emitted type**

In `backend-ts/scripts/gen-measure-bindings.mjs`, after the line that reads `const rf = line(s, "refusal");` (inside the `for` loop), add parsing for the new fields:

```js
  const cc = line(s, "complianceClass") ?? "RECURRING";
  const sr = line(s, "series");
```

Then change the `out.push({ ... })` object to include them (add these two properties before the closing `});`):

```js
    complianceClass: cc.trim().toUpperCase() === "PERMANENT" ? "PERMANENT" : "RECURRING",
    series: sr ? { requiredDoses: Number(inField(sr, "requiredDoses") ?? 2) } : undefined,
```

In the `.map((b) => { ... })` body builder, replace the `return ( ... )` so the emitted object includes the two fields. Replace the whole `return (...)` expression with:

```js
    const series = b.series ? `, series: ${JSON.stringify(b.series)}` : "";
    return (
      `  ${JSON.stringify(b.id)}: { rateKey: ${JSON.stringify(b.rateKey)}, complianceClass: ${JSON.stringify(b.complianceClass)}, complianceWindowDays: ${b.complianceWindowDays}, ` +
      `enrollment: ${JSON.stringify(b.enrollment)}, waiver: ${JSON.stringify(b.waiver)}, event: ${JSON.stringify(b.event)}${refusal}${series} },`
    );
```

In the emitted TypeScript header template (the `ts` template string), replace the `MeasureBinding` interface with:

```ts
export interface SeriesBinding {
  requiredDoses: number;
}

export interface MeasureBinding {
  rateKey: string;
  complianceClass: "PERMANENT" | "RECURRING";
  complianceWindowDays: number;
  enrollment: CodeBinding;
  waiver: CodeBinding;
  event: CodeBinding & { type: EventType };
  refusal?: CodeBinding;
  series?: SeriesBinding;
}
```

- [ ] **Step 4: Add `complianceClass: RECURRING` to the 11 existing YAMLs**

For each of `audiogram, hazwoper, tb_surveillance, flu_vaccine, hypertension, diabetes_hba1c, obesity_bmi, cholesterol_ldl, cms122, cms125, adult_immunization` `.yaml`, add a top-level line directly under `tags:` (top-level, NOT under `bindings:`):

```yaml
complianceClass: RECURRING
```

- [ ] **Step 5: Regenerate the bindings**

Run: `cd backend-ts && node scripts/gen-measure-bindings.mjs`
Expected: `wrote measure-bindings.ts for 11 measures` (14 after Task 3–5). Confirm `src/engine/synthetic/measure-bindings.ts` now shows `complianceClass: "RECURRING"` on each entry.

- [ ] **Step 6: Run the taxonomy test (first assertion only)**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/measure-bindings.taxonomy.test.ts`
Expected: the "RECURRING" test PASSES; the "PERMANENT mmr" test still FAILS (mmr added in Task 3).

- [ ] **Step 7: Verify the whole suite + types still green (no behavior change)**

Run: `cd backend-ts && pnpm typecheck && node --import tsx --test "src/**/*.test.ts"`
Expected: typecheck clean; all pre-existing tests pass (the field is additive). The one known failure is the mmr taxonomy assertion (Task 3).

- [ ] **Step 8: Commit**

```bash
cd backend-ts
git add scripts/gen-measure-bindings.mjs measures/*.yaml src/engine/synthetic/measure-bindings.ts src/engine/synthetic/measure-bindings.taxonomy.test.ts
git commit -m "feat(engine): add complianceClass + series binding metadata (E10.1, #188)"
```

---

### Task 2: Synthetic builder emits N immunization doses + series-aware exam config

**Files:**
- Modify: `backend-ts/src/engine/synthetic/exam-config.ts`
- Modify: `backend-ts/src/engine/synthetic/fhir-bundle-builder.ts`
- Test: `backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

In `backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts`, add at the end (the file already imports `deriveExamConfig`, `buildSyntheticBundle`, `emp`, and `EVAL_DATE` — reuse them, do not re-import):

```ts
test("permanent series: COMPLIANT bucket emits requiredDoses Immunizations", () => {
  // Build a synthetic PERMANENT binding inline (mmr binding lands in Task 3).
  const binding = {
    rateKey: "test_series", complianceClass: "PERMANENT" as const, complianceWindowDays: 0,
    enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
    waiver: { code: "x-contra", valueSet: "urn:workwell:vs:x-contra" },
    event: { code: "x-vaccine", valueSet: "urn:workwell:vs:x-vaccines", type: "immunization" as const },
    series: { requiredDoses: 2 },
  };
  const config = deriveExamConfig(binding, "COMPLIANT");
  assert.equal(config.doseCount, 2);
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);
  const imms = bundle.entry.filter((e) => (e.resource as Record<string, unknown>)["resourceType"] === "Immunization");
  assert.equal(imms.length, 2, "two completed doses expected for a 2-dose series");
});

test("permanent series: OVERDUE bucket emits a partial series (requiredDoses - 1)", () => {
  const binding = {
    rateKey: "test_series", complianceClass: "PERMANENT" as const, complianceWindowDays: 0,
    enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
    waiver: { code: "x-contra", valueSet: "urn:workwell:vs:x-contra" },
    event: { code: "x-vaccine", valueSet: "urn:workwell:vs:x-vaccines", type: "immunization" as const },
    series: { requiredDoses: 2 },
  };
  const config = deriveExamConfig(binding, "OVERDUE");
  assert.equal(config.doseCount, 1);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts`
Expected: FAIL — `config.doseCount` is `undefined` (field + branch not added yet).

- [ ] **Step 3: Add `doseCount` to ExamConfig + the PERMANENT branch**

In `backend-ts/src/engine/synthetic/exam-config.ts`, add `doseCount` to the `ExamConfig` interface (after `refused: boolean;`):

```ts
  /** For series/permanent measures: number of completed doses to emit (null = not a series). */
  doseCount: number | null;
```

In `deriveExamConfig`, at the very top of the function (before the `observation` branch), add the series branch:

```ts
  if (binding.complianceClass === "PERMANENT" && binding.series) {
    const required = binding.series.requiredDoses;
    const doseCount =
      target === "COMPLIANT" ? required
      : target === "OVERDUE" ? Math.max(required - 1, 1) // partial series → IN_PROGRESS (read model)
      : 0; // MISSING_DATA / EXCLUDED → no doses
    return {
      binding,
      // COMPLIANT uses old dose dates so the golden also proves "compliant forever".
      daysSinceLastExam: doseCount > 0 ? (target === "COMPLIANT" ? 3000 : 200) : null,
      hasWaiver: target === "EXCLUDED",
      programEnrolled: true,
      observationValue: null,
      refused: false,
      doseCount,
    };
  }
```

Then add `doseCount: null` to BOTH existing `return` objects (the observation branch and the recency branch) so the field is always present. Example for the recency branch's return:

```ts
  return { binding, daysSinceLastExam, hasWaiver, programEnrolled: true, observationValue: null, refused: false, doseCount: null };
```

- [ ] **Step 4: Emit N doses in the builder**

In `backend-ts/src/engine/synthetic/fhir-bundle-builder.ts`, replace the immunization-emitting branch (the `if (binding.event.type === "immunization") { ... }` block inside the `else if (config.daysSinceLastExam !== null)` section) with a dose-count-aware version:

```ts
    if (binding.event.type === "immunization") {
      const doses = config.doseCount ?? 1;
      for (let i = 0; i < doses; i++) {
        // Stagger doses ~60 days apart, anchored at `when` (oldest dose first).
        const doseWhen = dateMinusDays(evaluationDate, config.daysSinceLastExam + i * 60);
        entries.push({
          resource: {
            resourceType: "Immunization",
            meta: { profile: [QICORE_PROFILES.Immunization] },
            id: `${externalId}-immunization-${i}`,
            status: "completed",
            patient: { reference: `Patient/${externalId}` },
            vaccineCode: { coding: [coding] },
            occurrenceDateTime: doseWhen,
          },
        });
      }
    } else {
```

(The `when` const above this branch is now unused for immunizations; leave it — the `else` Procedure branch still uses it. If the linter flags `when` as unused only in the immunization path, it is still used by the Procedure `else`, so no change needed.)

- [ ] **Step 5: Run the builder test — verify it passes**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts`
Expected: PASS, including the two new series tests and all pre-existing cases (recency measures have `doseCount: null` → the loop emits 1 dose, identical to before).

- [ ] **Step 6: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd backend-ts
git add src/engine/synthetic/exam-config.ts src/engine/synthetic/fhir-bundle-builder.ts src/engine/synthetic/fhir-bundle-builder.test.ts
git commit -m "feat(engine): synthetic multi-dose immunization + series exam-config (E10.6, #193)"
```

---

### Task 3: MMR series-completion measure (CQL + value sets + registry + catalog + golden)

**Files:**
- Create: `backend-ts/measures/mmr.cql`, `backend-ts/measures/mmr.yaml`
- Modify: `backend-ts/src/measure/value-set-seed.ts`, `src/engine/cql/measure-registry.ts`, `src/measure/measure-catalog.ts`
- Test: `backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts` (add MMR cases)

- [ ] **Step 1: Write `mmr.cql`**

Create `backend-ts/measures/mmr.cql`:

```cql
library MmrSeries version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "MMR Vaccines": 'urn:workwell:vs:mmr-vaccines'
valueset "Immunization Program Enrollment": 'urn:workwell:vs:immz-enrollment'
valueset "MMR Contraindication": 'urn:workwell:vs:mmr-contraindication'
valueset "MMR Refusal": 'urn:workwell:vs:mmr-refusal'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Enrolled":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:immz-enrollment' and x.code = 'immz-enrolled'))

define "Has Contraindication":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:mmr-contraindication' and x.code = 'mmr-contraindication'))

define "Refused":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:mmr-refusal' and x.code = 'mmr-refusal'))

define "Valid Doses":
  [Immunization] I
    where exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:mmr-vaccines' and C.code = 'mmr-vaccine')

define "Dose Count": Count("Valid Doses")

define "Series Complete":
  "Enrolled" and not "Has Contraindication" and "Dose Count" >= 2

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
```

- [ ] **Step 2: Write `mmr.yaml`**

Create `backend-ts/measures/mmr.yaml`:

```yaml
id: mmr
name: MMR Immunity (2-dose series)
version: 1.0.0
title: Measles–Mumps–Rubella immunity (2 valid doses)
policyRef: CDC ACIP MMR recommendations
tags: [wellness, immunization, mmr, permanent]
complianceClass: PERMANENT
cql: mmr.cql
bindings:
  rateKey: mmr
  complianceWindowDays: 0
  series: { requiredDoses: 2 }
  enrollment: { code: immz-enrolled, valueSet: "urn:workwell:vs:immz-enrollment" }
  waiver:     { code: mmr-contraindication, valueSet: "urn:workwell:vs:mmr-contraindication" }
  event:      { code: mmr-vaccine, valueSet: "urn:workwell:vs:mmr-vaccines", type: immunization }
  refusal:    { code: mmr-refusal, valueSet: "urn:workwell:vs:mmr-refusal" }
```

> The generator's `inField` regex reads `requiredDoses` from the `series:` line; `complianceClass` is read from the top-level line.

- [ ] **Step 3: Add the MMR value sets + link**

In `backend-ts/src/measure/value-set-seed.ts`, add to the `VALUE_SETS` array (after the wellness sets, before the closing `]`):

```ts
  // immunization shared enrollment + MMR sets (E10.6)
  { id: "c0000001-0000-0000-0000-000000000001", oid: "urn:workwell:vs:immz-enrollment", name: "Immunization Program Enrollment", codes: [c("immz-enrolled", "Immunization Program Enrollment", "urn:workwell:vs:immz-enrollment")] },
  { id: "c0000001-0000-0000-0000-000000000002", oid: "urn:workwell:vs:mmr-vaccines", name: "MMR Vaccines", codes: [
    c("mmr-vaccine", "MMR Vaccines", "urn:workwell:vs:mmr-vaccines"),
    c("03", "MMR", CVX),
    c("94", "MMRV", CVX),
  ] },
  { id: "c0000001-0000-0000-0000-000000000003", oid: "urn:workwell:vs:mmr-contraindication", name: "MMR Contraindication", codes: [c("mmr-contraindication", "MMR Contraindication", "urn:workwell:vs:mmr-contraindication")] },
  { id: "c0000001-0000-0000-0000-000000000004", oid: "urn:workwell:vs:mmr-refusal", name: "MMR Refusal", codes: [c("mmr-refusal", "MMR Refusal", "urn:workwell:vs:mmr-refusal")] },
```

In the `LINKS` record add:

```ts
  mmr: ["c0000001-0000-0000-0000-000000000002", "c0000001-0000-0000-0000-000000000001", "c0000001-0000-0000-0000-000000000003"],
```

- [ ] **Step 4: Register MMR in the runtime registry**

In `backend-ts/src/engine/cql/measure-registry.ts`, add to `MEASURES` (after `adult_immunization`):

```ts
  mmr: { id: "mmr", name: "MMR Immunity (2-dose series)", library: "MmrSeries-1.0.0", periodMonths: 0 },
```

- [ ] **Step 5: Add the MMR catalog entry**

In `backend-ts/src/measure/measure-catalog.ts`, add after the `adult_immunization` entry (line ~49):

```ts
  {"id":"mmr","name":"MMR Immunity (2-dose series)","policyRef":"CDC ACIP MMR recommendations","version":"v1.0","status":"Active","owner":"system","tags":["wellness","immunization","mmr","permanent"],"compileStatus":"COMPILED","spec":{"description":"Measles–Mumps–Rubella immunity by completed 2-dose series. PERMANENT: once 2 valid doses are on file the employee is compliant indefinitely (no recency window). Contraindication excludes; documented refusal keeps the case open.","eligibilityCriteria":{"roleFilter":"All","siteFilter":"All Sites","programEnrollmentText":"Immunization Program"},"exclusions":[{"label":"Clinical Contraindication","criteriaText":"Documented MMR contraindication on file"}],"complianceWindow":"Permanent (2 valid doses, no recency window)","requiredDataElements":["MMR dose dates","Program enrollment","Contraindication status","Refusal status"],"testFixtures":[]}},
```

- [ ] **Step 6: Compile CQL → ELM**

Run: `cd backend-ts && pnpm compile-measures`
Expected: console lists a compiled `MmrSeries-1.0.0`; `src/engine/cql/elm/MmrSeries-1.0.0.elm.json` is created and `src/engine/cql/elm/index.ts` is regenerated to import it. If the output reports CQL translation errors, fix `mmr.cql` and re-run before proceeding.

- [ ] **Step 7: Regenerate bindings**

Run: `cd backend-ts && node scripts/gen-measure-bindings.mjs`
Expected: `wrote measure-bindings.ts for 12 measures`; `MEASURE_BINDINGS.mmr` shows `complianceClass: "PERMANENT"` and `series: {"requiredDoses":2}`.

- [ ] **Step 8: Add MMR generation→evaluation golden cases**

In `backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts`, add to the `CASES` array:

```ts
  // PERMANENT series (MMR): COMPLIANT (old doses still compliant), partial → MISSING_DATA, none → MISSING_DATA, excluded
  ["mmr", "COMPLIANT", "COMPLIANT"],
  ["mmr", "OVERDUE", "MISSING_DATA"],     // partial series (1 of 2) → canonical MISSING_DATA (read model shows IN_PROGRESS)
  ["mmr", "MISSING_DATA", "MISSING_DATA"],
  ["mmr", "EXCLUDED", "EXCLUDED"],
```

- [ ] **Step 9: Run the golden — verify MMR evaluates correctly**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts`
Expected: PASS — `mmr: seeded COMPLIANT → engine COMPLIANT` etc. This proves: 2 doses (dated 3000 days ago) → COMPLIANT (permanence), 1 dose → MISSING_DATA, 0 doses → MISSING_DATA, contraindication → EXCLUDED.

- [ ] **Step 10: Run the taxonomy test (now fully green)**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/measure-bindings.taxonomy.test.ts`
Expected: PASS (both assertions).

- [ ] **Step 11: Commit**

```bash
cd backend-ts
git add measures/mmr.cql measures/mmr.yaml src/measure/value-set-seed.ts src/engine/cql/measure-registry.ts src/measure/measure-catalog.ts src/engine/cql/elm/ src/engine/synthetic/measure-bindings.ts src/engine/synthetic/fhir-bundle-builder.test.ts
git commit -m "feat(measure): MMR permanent series-completion measure (E10.6, #193)"
```

---

### Task 4: Varicella series-completion measure

**Files:** mirror Task 3 with Varicella params.
- Create: `backend-ts/measures/varicella.cql`, `varicella.yaml`
- Modify: `value-set-seed.ts`, `measure-registry.ts`, `measure-catalog.ts`, `fhir-bundle-builder.test.ts`

- [ ] **Step 1: Write `varicella.cql`**

Create `backend-ts/measures/varicella.cql`:

```cql
library VaricellaSeries version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "Varicella Vaccines": 'urn:workwell:vs:varicella-vaccines'
valueset "Immunization Program Enrollment": 'urn:workwell:vs:immz-enrollment'
valueset "Varicella Contraindication": 'urn:workwell:vs:varicella-contraindication'
valueset "Varicella Refusal": 'urn:workwell:vs:varicella-refusal'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Enrolled":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:immz-enrollment' and x.code = 'immz-enrolled'))

define "Has Contraindication":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:varicella-contraindication' and x.code = 'varicella-contraindication'))

define "Refused":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:varicella-refusal' and x.code = 'varicella-refusal'))

define "Valid Doses":
  [Immunization] I
    where exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:varicella-vaccines' and C.code = 'varicella-vaccine')

define "Dose Count": Count("Valid Doses")

define "Series Complete":
  "Enrolled" and not "Has Contraindication" and "Dose Count" >= 2

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
```

- [ ] **Step 2: Write `varicella.yaml`**

Create `backend-ts/measures/varicella.yaml`:

```yaml
id: varicella
name: Varicella Immunity (2-dose series)
version: 1.0.0
title: Varicella (chickenpox) immunity (2 valid doses)
policyRef: CDC ACIP Varicella recommendations
tags: [wellness, immunization, varicella, permanent]
complianceClass: PERMANENT
cql: varicella.cql
bindings:
  rateKey: varicella
  complianceWindowDays: 0
  series: { requiredDoses: 2 }
  enrollment: { code: immz-enrolled, valueSet: "urn:workwell:vs:immz-enrollment" }
  waiver:     { code: varicella-contraindication, valueSet: "urn:workwell:vs:varicella-contraindication" }
  event:      { code: varicella-vaccine, valueSet: "urn:workwell:vs:varicella-vaccines", type: immunization }
  refusal:    { code: varicella-refusal, valueSet: "urn:workwell:vs:varicella-refusal" }
```

- [ ] **Step 3: Add Varicella value sets + link**

In `value-set-seed.ts` `VALUE_SETS`:

```ts
  { id: "c0000001-0000-0000-0000-000000000005", oid: "urn:workwell:vs:varicella-vaccines", name: "Varicella Vaccines", codes: [
    c("varicella-vaccine", "Varicella Vaccines", "urn:workwell:vs:varicella-vaccines"),
    c("21", "Varicella", CVX),
  ] },
  { id: "c0000001-0000-0000-0000-000000000006", oid: "urn:workwell:vs:varicella-contraindication", name: "Varicella Contraindication", codes: [c("varicella-contraindication", "Varicella Contraindication", "urn:workwell:vs:varicella-contraindication")] },
  { id: "c0000001-0000-0000-0000-000000000007", oid: "urn:workwell:vs:varicella-refusal", name: "Varicella Refusal", codes: [c("varicella-refusal", "Varicella Refusal", "urn:workwell:vs:varicella-refusal")] },
```

In `LINKS`:

```ts
  varicella: ["c0000001-0000-0000-0000-000000000005", "c0000001-0000-0000-0000-000000000001", "c0000001-0000-0000-0000-000000000006"],
```

- [ ] **Step 4: Register + catalog**

In `measure-registry.ts` `MEASURES`:

```ts
  varicella: { id: "varicella", name: "Varicella Immunity (2-dose series)", library: "VaricellaSeries-1.0.0", periodMonths: 0 },
```

In `measure-catalog.ts` (after the `mmr` entry):

```ts
  {"id":"varicella","name":"Varicella Immunity (2-dose series)","policyRef":"CDC ACIP Varicella recommendations","version":"v1.0","status":"Active","owner":"system","tags":["wellness","immunization","varicella","permanent"],"compileStatus":"COMPILED","spec":{"description":"Varicella (chickenpox) immunity by completed 2-dose series. PERMANENT: once 2 valid doses are on file the employee is compliant indefinitely. Contraindication excludes; documented refusal keeps the case open.","eligibilityCriteria":{"roleFilter":"All","siteFilter":"All Sites","programEnrollmentText":"Immunization Program"},"exclusions":[{"label":"Clinical Contraindication","criteriaText":"Documented varicella contraindication on file"}],"complianceWindow":"Permanent (2 valid doses, no recency window)","requiredDataElements":["Varicella dose dates","Program enrollment","Contraindication status","Refusal status"],"testFixtures":[]}},
```

- [ ] **Step 5: Compile + regen + golden cases**

Run: `cd backend-ts && pnpm compile-measures && node scripts/gen-measure-bindings.mjs`
Expected: `VaricellaSeries-1.0.0` compiled; `wrote measure-bindings.ts for 13 measures`.

In `fhir-bundle-builder.test.ts` `CASES` add:

```ts
  ["varicella", "COMPLIANT", "COMPLIANT"],
  ["varicella", "OVERDUE", "MISSING_DATA"],
  ["varicella", "MISSING_DATA", "MISSING_DATA"],
  ["varicella", "EXCLUDED", "EXCLUDED"],
```

- [ ] **Step 6: Run the golden — verify**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts`
Expected: PASS for all varicella cases.

- [ ] **Step 7: Commit**

```bash
cd backend-ts
git add measures/varicella.cql measures/varicella.yaml src/measure/value-set-seed.ts src/engine/cql/measure-registry.ts src/measure/measure-catalog.ts src/engine/cql/elm/ src/engine/synthetic/measure-bindings.ts src/engine/synthetic/fhir-bundle-builder.test.ts
git commit -m "feat(measure): Varicella permanent series-completion measure (E10.6, #193)"
```

---

### Task 5: Hepatitis B series — promote the existing catalog entry to runnable

**Files:**
- Create: `backend-ts/measures/hepatitis_b.cql`, `hepatitis_b.yaml`
- Modify: `value-set-seed.ts`, `measure-registry.ts`, `measure-catalog.ts` (promote existing entry), `fhir-bundle-builder.test.ts`

- [ ] **Step 1: Write `hepatitis_b.cql`** (id stays `hepatitis_b_vaccination_series`)

Create `backend-ts/measures/hepatitis_b.cql`:

```cql
library HepatitisBSeries version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "Hep B Vaccines": 'urn:workwell:vs:hepb-vaccines'
valueset "Immunization Program Enrollment": 'urn:workwell:vs:immz-enrollment'
valueset "Hep B Contraindication": 'urn:workwell:vs:hepb-contraindication'
valueset "Hep B Refusal": 'urn:workwell:vs:hepb-refusal'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Enrolled":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:immz-enrollment' and x.code = 'immz-enrolled'))

define "Has Contraindication":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:hepb-contraindication' and x.code = 'hepb-contraindication'))

define "Refused":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:hepb-refusal' and x.code = 'hepb-refusal'))

define "Valid Doses":
  [Immunization] I
    where exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:hepb-vaccines' and C.code = 'hepb-vaccine')

define "Dose Count": Count("Valid Doses")

define "Series Complete":
  "Enrolled" and not "Has Contraindication" and "Dose Count" >= 2

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
```

- [ ] **Step 2: Write `hepatitis_b.yaml`** (the `id` MUST be `hepatitis_b_vaccination_series` to match the existing catalog entry + registry key)

Create `backend-ts/measures/hepatitis_b.yaml`:

```yaml
id: hepatitis_b_vaccination_series
name: Hepatitis B Vaccination Series
version: 1.0.0
title: Hepatitis B vaccination series completion
policyRef: OSHA 29 CFR 1910.1030
tags: [vaccine, bbp, osha, permanent]
complianceClass: PERMANENT
cql: hepatitis_b.cql
bindings:
  rateKey: hepatitis_b_vaccination_series
  complianceWindowDays: 0
  series: { requiredDoses: 2 }
  enrollment: { code: immz-enrolled, valueSet: "urn:workwell:vs:immz-enrollment" }
  waiver:     { code: hepb-contraindication, valueSet: "urn:workwell:vs:hepb-contraindication" }
  event:      { code: hepb-vaccine, valueSet: "urn:workwell:vs:hepb-vaccines", type: immunization }
  refusal:    { code: hepb-refusal, valueSet: "urn:workwell:vs:hepb-refusal" }
```

> Library id `HepatitisBSeries-1.0.0`. requiredDoses=2 covers the Heplisav 2-dose series; the Heplisav-vs-traditional-3-dose distinction + titer-proves-immunity are E11 (deferred per spec).

- [ ] **Step 3: Add Hep B value sets + link**

In `value-set-seed.ts` `VALUE_SETS`:

```ts
  { id: "c0000001-0000-0000-0000-000000000008", oid: "urn:workwell:vs:hepb-vaccines", name: "Hepatitis B Vaccines", codes: [
    c("hepb-vaccine", "Hepatitis B Vaccines", "urn:workwell:vs:hepb-vaccines"),
    c("08", "Hep B adolescent or pediatric", CVX),
    c("43", "Hep B adult", CVX),
    c("189", "Hep B Heplisav-B", CVX),
  ] },
  { id: "c0000001-0000-0000-0000-000000000009", oid: "urn:workwell:vs:hepb-contraindication", name: "Hepatitis B Contraindication", codes: [c("hepb-contraindication", "Hepatitis B Contraindication", "urn:workwell:vs:hepb-contraindication")] },
  { id: "c0000001-0000-0000-0000-00000000000a", oid: "urn:workwell:vs:hepb-refusal", name: "Hepatitis B Refusal", codes: [c("hepb-refusal", "Hepatitis B Refusal", "urn:workwell:vs:hepb-refusal")] },
```

In `LINKS`:

```ts
  hepatitis_b_vaccination_series: ["c0000001-0000-0000-0000-000000000008", "c0000001-0000-0000-0000-000000000001", "c0000001-0000-0000-0000-000000000009"],
```

- [ ] **Step 4: Register + promote catalog entry**

In `measure-registry.ts` `MEASURES`:

```ts
  hepatitis_b_vaccination_series: { id: "hepatitis_b_vaccination_series", name: "Hepatitis B Vaccination Series", library: "HepatitisBSeries-1.0.0", periodMonths: 0 },
```

In `measure-catalog.ts`, find the existing `hepatitis_b_vaccination_series` entry (currently `"status":"Approved"`) and change ONLY `"status":"Approved"` → `"status":"Active"` (it is already `"compileStatus":"COMPILED"`). Leave the rest of that entry as-is.

- [ ] **Step 5: Compile + regen + golden cases**

Run: `cd backend-ts && pnpm compile-measures && node scripts/gen-measure-bindings.mjs`
Expected: `HepatitisBSeries-1.0.0` compiled; `wrote measure-bindings.ts for 14 measures`.

In `fhir-bundle-builder.test.ts` `CASES` add:

```ts
  ["hepatitis_b_vaccination_series", "COMPLIANT", "COMPLIANT"],
  ["hepatitis_b_vaccination_series", "OVERDUE", "MISSING_DATA"],
  ["hepatitis_b_vaccination_series", "MISSING_DATA", "MISSING_DATA"],
  ["hepatitis_b_vaccination_series", "EXCLUDED", "EXCLUDED"],
```

- [ ] **Step 6: Run the golden — verify**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts`
Expected: PASS for all Hep B cases.

- [ ] **Step 7: Commit**

```bash
cd backend-ts
git add measures/hepatitis_b.cql measures/hepatitis_b.yaml src/measure/value-set-seed.ts src/engine/cql/measure-registry.ts src/measure/measure-catalog.ts src/engine/cql/elm/ src/engine/synthetic/measure-bindings.ts src/engine/synthetic/fhir-bundle-builder.test.ts
git commit -m "feat(measure): promote Hepatitis B series to runnable permanent measure (E10.6, #193)"
```

---

### Task 6: Static spike fixtures + CLI golden override for PERMANENT measures

**Files:**
- Create: 12 fixtures under `backend-ts/spike/synthetic/{mmr,varicella,hepatitis_b_vaccination_series}/`
- Modify: `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`

- [ ] **Step 1: Author the MMR fixtures**

The CLI golden loads `spike/synthetic/<measureId>/<scenario>.json`. Create four files for `mmr`. Use this exact shape (the immunization `system`/`code` must match the CQL: `urn:workwell:vs:mmr-vaccines` / `mmr-vaccine`).

`backend-ts/spike/synthetic/mmr/present_recent.json` (2 recent doses → COMPLIANT):
```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    { "resource": { "resourceType": "Patient", "id": "mmr-present_recent" } },
    { "resource": { "resourceType": "Condition", "id": "mmr-present_recent-enr", "subject": { "reference": "Patient/mmr-present_recent" }, "code": { "coding": [ { "system": "urn:workwell:vs:immz-enrollment", "code": "immz-enrolled" } ] } } },
    { "resource": { "resourceType": "Immunization", "id": "mmr-present_recent-d1", "status": "completed", "patient": { "reference": "Patient/mmr-present_recent" }, "vaccineCode": { "coding": [ { "system": "urn:workwell:vs:mmr-vaccines", "code": "mmr-vaccine" } ] }, "occurrenceDateTime": "2024-01-10T00:00:00" } },
    { "resource": { "resourceType": "Immunization", "id": "mmr-present_recent-d2", "status": "completed", "patient": { "reference": "Patient/mmr-present_recent" }, "vaccineCode": { "coding": [ { "system": "urn:workwell:vs:mmr-vaccines", "code": "mmr-vaccine" } ] }, "occurrenceDateTime": "2024-02-10T00:00:00" } }
  ]
}
```

`backend-ts/spike/synthetic/mmr/present_old.json` (2 OLD doses → still COMPLIANT — the permanence proof). Identical to `present_recent.json` but change `id` prefix to `mmr-present_old`, the references accordingly, and both `occurrenceDateTime` to `2003-05-01T00:00:00` and `2003-06-01T00:00:00`.

`backend-ts/spike/synthetic/mmr/missing.json` (enrolled, 0 doses → MISSING_DATA):
```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    { "resource": { "resourceType": "Patient", "id": "mmr-missing" } },
    { "resource": { "resourceType": "Condition", "id": "mmr-missing-enr", "subject": { "reference": "Patient/mmr-missing" }, "code": { "coding": [ { "system": "urn:workwell:vs:immz-enrollment", "code": "immz-enrolled" } ] } } }
  ]
}
```

`backend-ts/spike/synthetic/mmr/excluded.json` (contraindication → EXCLUDED):
```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    { "resource": { "resourceType": "Patient", "id": "mmr-excluded" } },
    { "resource": { "resourceType": "Condition", "id": "mmr-excluded-enr", "subject": { "reference": "Patient/mmr-excluded" }, "code": { "coding": [ { "system": "urn:workwell:vs:immz-enrollment", "code": "immz-enrolled" } ] } } },
    { "resource": { "resourceType": "Condition", "id": "mmr-excluded-contra", "subject": { "reference": "Patient/mmr-excluded" }, "code": { "coding": [ { "system": "urn:workwell:vs:mmr-contraindication", "code": "mmr-contraindication" } ] } } }
  ]
}
```

- [ ] **Step 2: Author the Varicella + Hep B fixtures**

Repeat Step 1's four files for `varicella` (replace `mmr` → `varicella` in ids, and the vaccine coding with `urn:workwell:vs:varicella-vaccines`/`varicella-vaccine`, contraindication with `urn:workwell:vs:varicella-contraindication`/`varicella-contraindication`) and for `hepatitis_b_vaccination_series` (ids prefixed `hepb-...`, vaccine coding `urn:workwell:vs:hepb-vaccines`/`hepb-vaccine`, contraindication `urn:workwell:vs:hepb-contraindication`/`hepb-contraindication`). Keep the enrollment coding (`urn:workwell:vs:immz-enrollment`/`immz-enrolled`) identical across all three.

- [ ] **Step 3: Add the per-measure PERMANENT override to the CLI golden**

In `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`, after the `EXPECTED` constant, add:

```ts
// PERMANENT measures have no recency window — old doses stay COMPLIANT (the "compliant forever" proof).
const PERMANENT = new Set(["mmr", "varicella", "hepatitis_b_vaccination_series"]);
const expectedFor = (measureId: string, scenario: string): string =>
  PERMANENT.has(measureId) && scenario === "present_old" ? "COMPLIANT" : EXPECTED[scenario]!;
```

Then in the golden loop, change the assertion line from `assert.equal(outcome.outcome, expected, ...)` to use `expectedFor`:

```ts
for (const measureId of Object.keys(MEASURES)) {
  test(`golden: CLI matches expected outcomes for ${measureId} (all scenarios)`, async () => {
    for (const scenario of Object.keys(EXPECTED)) {
      const expected = expectedFor(measureId, scenario);
      const outcome = await run(["--patient", fixture(measureId, scenario), "--measure", measureId, "--date", EVAL]);
      assert.equal(outcome.outcome, expected, `${measureId}/${scenario}`);
      assert.equal(outcome.measure, MEASURES[measureId]!.name);
    }
  });
}
```

- [ ] **Step 4: Run the CLI golden — verify all 14 measures pass**

Run: `cd backend-ts && node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts`
Expected: PASS for all 14 measures × 4 scenarios, including `mmr/present_old → COMPLIANT`, `varicella/present_old → COMPLIANT`, `hepatitis_b_vaccination_series/present_old → COMPLIANT`.

- [ ] **Step 5: Commit**

```bash
cd backend-ts
git add spike/synthetic/mmr spike/synthetic/varicella spike/synthetic/hepatitis_b_vaccination_series src/engine/cli/evaluate-measure-cli.test.ts
git commit -m "test(engine): spike fixtures + permanent-measure golden override (E10.6, #193)"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `docs/MEASURES.md`

- [ ] **Step 1: Document the taxonomy + 3 measures in `docs/MEASURES.md`**

In `docs/MEASURES.md`, in the "Category 3 — HEDIS Wellness" area, add a short subsection:

```markdown
### Measure compliance taxonomy: PERMANENT vs RECURRING (E10.1)

Each runnable measure carries a `complianceClass` in its YAML binding:
- **RECURRING** (default, all prior measures) — windowed days-since-last-event with DUE_SOON/OVERDUE.
- **PERMANENT** — "once compliant, always compliant": a completed dose series stays COMPLIANT with no recency window.

### Permanent immunization panel (E10.6)

| Measure | id | Series | COMPLIANT when |
|---|---|---|---|
| MMR Immunity | `mmr` | 2 doses | >= 2 valid MMR doses on file |
| Varicella Immunity | `varicella` | 2 doses | >= 2 valid varicella doses on file |
| Hepatitis B Vaccination Series | `hepatitis_b_vaccination_series` | 2 doses (Heplisav) | >= 2 valid Hep B doses on file |

All three: `EXCLUDED` on a documented contraindication; a documented refusal keeps the case open
(surfaced as DECLINED in the roster read model, E10.5). A partial series (< required doses) is
canonically MISSING_DATA and shown as IN_PROGRESS by the read model (Plan 2). The Heplisav-vs-traditional
distinction and titer-proves-immunity are deferred to E11. The catalog is now **14 runnable measures**.
```

- [ ] **Step 2: Full backend verification**

Run: `cd backend-ts && pnpm typecheck && node --import tsx --test "src/**/*.test.ts"`
Expected: typecheck clean; the entire backend-ts suite passes (the ~430 existing tests + the new taxonomy/series/golden tests).

- [ ] **Step 3: Sanity-check via the headless CLI**

Run: `cd backend-ts && pnpm evaluate --patient ./spike/synthetic/mmr/present_old.json --measure mmr --date 2026-06-22 --pretty`
Expected: JSON with `"outcome": "COMPLIANT"` and an `expressionResults` entry `{ "define": "Dose Count", "result": 2 }`.

- [ ] **Step 4: Commit**

```bash
cd backend-ts && cd ..
git add docs/MEASURES.md
git commit -m "docs(measures): document PERMANENT/RECURRING taxonomy + vaccine panel (E10.1/E10.6)"
```

---

## What Plan 1 delivers / what's next

After Plan 1: 14 runnable measures, `complianceClass` taxonomy, and 3 permanent vaccine measures whose evidence carries `Dose Count` + `Refused` defines. The engine still emits only the 5 canonical buckets.

**Plan 2 (E10.2 + E10.5)** consumes this: a `GET /api/compliance/roster` read model that turns the canonical buckets + `Dose Count`/enrollment/`Refused` evidence + `complianceClass` into per-cell `{ status (incl. IN_PROGRESS/DECLINED/NA), method }`. **Plan 3 (E10.3 + E10.4)** is the grid + per-employee screen.
