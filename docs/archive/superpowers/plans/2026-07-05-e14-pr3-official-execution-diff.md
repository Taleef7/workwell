# E14 PR-3 — Official-subset CMS122 execution outcome diff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `GET /api/measures/cms122/fidelity/diff` from a criteria-impact *estimate* into a real, subject-by-subject *execution* diff — evaluating a faithful official-subset CMS122 measure (VSAC-value-set-driven) against each subject and diffing against WorkWell's authored outcome.

**Architecture:** A new `measures/cms122_official.cql` (authored `using FHIR '4.0.1'`, value-set-retrieve style) auto-compiles to committed ELM. The engine gains a backward-compatible `metaOverride` so the official measure evaluates **without** entering the `MEASURES` registry (which is iterated by seed/backfill/tests). A diff-harness (`standards/execution-diff.ts`) builds each subject's synthetic bundle, applies a harness-local additive enrichment with real VSAC-member codes, evaluates both measures fresh via a store-backed resolver, and diffs — degrading to the PR-2 estimate when the imported VSAC rows are absent. Descriptive only (ADR-008): writes nothing.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, `@cqframework/cql` (build-time CQL→ELM, JVM-free), `cql-execution` + `cql-exec-fhir`, SQLite floor / Postgres ceiling stores. Run tests with `corepack pnpm -C backend-ts test`; typecheck with `corepack pnpm -C backend-ts typecheck`; compile CQL with `corepack pnpm -C backend-ts compile-measures`.

**Spec:** `docs/superpowers/specs/2026-07-05-e14-pr3-official-execution-diff-design.md`

**Conventions:** `tsconfig` has `noUncheckedIndexedAccess: true` — use `arr[0]!` after a length/existence check. Test files are `*.test.ts` beside the source. Commit per task (Conventional Commits, scope `e14`).

---

## Reference facts (verified during design — do not re-derive)

- **Registry pollution:** `Object.keys(MEASURES)` is iterated by `run/backfill-scale.ts`, `run/backfill-quality-history.ts`, `segment/segment-seed.test.ts` (orphan check), `order/order-catalog.test.ts`, and the two golden tests (`cql-execution-engine.test.ts`, `engine/cli/evaluate-measure-cli.test.ts`). **The official measure must NOT be added to `MEASURES`.**
- **Engine seam:** `CqlExecutionEngine.evaluate(input)` (`src/engine/cql/cql-execution-engine.ts:73`) looks up `MEASURES[input.measureId]` for meta and, when `opts.valueSetResolver != null && meta.expansionLibrary != null && meta.valueSets != null`, loads `meta.expansionLibrary` ELM and builds a `CodeService` from `buildCodeService(resolver, meta.valueSets)`. It already accepts an `input.elm` override.
- **Store resolver:** `StoreValueSetResolver.expand(url)` (`src/engine/cql/value-set-resolver.ts:27`) matches `v.oid === url || v.canonicalUrl === url` — so a **bare-OID** valueset reference resolves from the imported `value_sets` row. **No resolver change needed.** No VSAC key needed at runtime (store-backed).
- **Compile flow:** `scripts/compile-measures.mjs` auto-compiles every `measures/*.cql` → `src/engine/cql/elm/<LibraryId>-<version>.elm.json` and regenerates `src/engine/cql/elm/index.ts` (`ELM_LIBRARIES`). It **throws on error-severity** translation errors. The ELM key = the CQL `library <Id> version '<v>'` header → `<Id>-<v>`.
- **Per-subject eval recipe** (mirror `src/run/employee-compliance-snapshot.ts`): `EMPLOYEES` (`engine/synthetic/employee-catalog.ts`) → `seededTargetFor(employees, binding.rateKey, externalId)` (`run/distribution.ts:81`) → `deriveExamConfig(binding, target)` (`engine/synthetic/exam-config.ts`) → `buildSyntheticBundle(employee, config, today)` (`engine/synthetic/fhir-bundle-builder.ts:68`) → `engine.evaluate({measureId, patientBundle, evaluationDate})`.
- **cms122 binding** (`engine/synthetic/measure-bindings.ts`): `rateKey:"cms122"`, enrollment `{code:"cms122-diabetes", valueSet:"urn:workwell:vs:cms122-diabetes"}` (the diabetes Condition), waiver `{code:"cms122-excluded", valueSet:"urn:workwell:vs:cms122-excluded"}`, event `{code:"hba1c-obs", valueSet:"urn:workwell:vs:cms122-hba1c", type:"observation"}` (the HbA1c Observation).
- **Diff route** (`src/routes/measures.ts:442-450`): `referenceFor(diffId)` → `OfficialMeasureReference | undefined`; `listOutcomesWithRun({measureId, excludeScale:true})`; filter `isPopulationRun(o.runScopeType) && isCompletedRun(o.runStatus)`; `latestRunRows(...)` → the latest run's rows (each row has `subjectId`, `status`, `runId`, `runStartedAt`); `computeOutcomeDiff(ref, latestRows, year)`.
- **Official reference + OIDs:** `src/standards/references/cms122v14.ts` (`CMS122V14`) already enumerates every OID this plan uses (Diabetes, HbA1c, the 7 qualifying-visit encounter sets, 3 hospice, palliative, frailty). These are the 21 OIDs `pnpm resolve-valuesets` imports.
- **FHIR retrieve code paths (cql-exec-fhir):** `Encounter` retrieves match on `Encounter.type`; `Condition` on `Condition.code`; `Observation` on `Observation.code`. Enrichment must stamp member codings on those paths.

---

## Task 1: Official-subset CMS122 CQL + `metaOverride` engine seam + golden

**Files:**
- Create: `backend-ts/measures/cms122_official.cql`
- Modify: `backend-ts/src/engine/cql/cql-execution-engine.ts` (add `metaOverride`)
- Create: `backend-ts/src/standards/cms122-official.ts` (inline meta + OID list; enrichment added in Task 2)
- Create: `backend-ts/src/standards/cms122-official.test.ts`

- [ ] **Step 1: Write the official-subset CQL**

Create `backend-ts/measures/cms122_official.cql`:

```cql
library DiabetesHbA1cPoorControlOfficialCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

// Official CMS122v14 VSAC value sets, referenced by bare OID. These resolve at runtime from the
// imported `value_sets` rows (source='VSAC') via StoreValueSetResolver (bare-OID match). This is a
// FAITHFUL-BUT-SIMPLIFIED transcription of the official measure's population logic — NOT the literal
// multi-library QICore artifact (spike-proven un-compilable under @cqframework/cql 4.0.0-beta.1).
// Descriptive only (ADR-008): never decides a stored compliance outcome.
valueset "Diabetes": '2.16.840.1.113883.3.464.1003.103.12.1001'
valueset "HbA1c Laboratory Test": '2.16.840.1.113883.3.464.1003.198.12.1013'
valueset "Office Visit": '2.16.840.1.113883.3.464.1003.101.12.1001'
valueset "Annual Wellness Visit": '2.16.840.1.113883.3.526.3.1240'
valueset "Preventive Care Established Office Visit 18+": '2.16.840.1.113883.3.464.1003.101.12.1025'
valueset "Preventive Care Initial Office Visit 18+": '2.16.840.1.113883.3.464.1003.101.12.1023'
valueset "Home Healthcare Services": '2.16.840.1.113883.3.464.1003.101.12.1016'
valueset "Telephone Visits": '2.16.840.1.113883.3.464.1003.101.12.1080'
valueset "Nutrition Services": '2.16.840.1.113883.3.464.1003.1006'
valueset "Hospice Encounter": '2.16.840.1.113883.3.464.1003.1003'
valueset "Palliative Care Diagnosis": '2.16.840.1.113883.3.464.1003.1167'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Age At End":
  AgeInYearsAt(end of "Measurement Period")

define "Age 18 To 75":
  "Age At End" >= 18 and "Age At End" <= 75

define "Has Qualifying Visit":
  exists([Encounter: "Office Visit"])
    or exists([Encounter: "Annual Wellness Visit"])
    or exists([Encounter: "Preventive Care Established Office Visit 18+"])
    or exists([Encounter: "Preventive Care Initial Office Visit 18+"])
    or exists([Encounter: "Home Healthcare Services"])
    or exists([Encounter: "Telephone Visits"])
    or exists([Encounter: "Nutrition Services"])

define "Has Diabetes":
  exists([Condition: "Diabetes"])

define "Initial Population":
  "Age 18 To 75" and "Has Qualifying Visit" and "Has Diabetes"

define "Has Hospice":
  exists([Encounter: "Hospice Encounter"])

define "Has Palliative":
  exists([Condition: "Palliative Care Diagnosis"])

define "Denominator Exclusions":
  "Initial Population" and ("Has Hospice" or "Has Palliative")

define "Most Recent HbA1c":
  Last([Observation: "HbA1c Laboratory Test"] O
    where O.status.value in {'final', 'amended', 'corrected'}
    sort by (effective as FHIR.dateTime))

define "Most Recent HbA1c Value":
  ("Most Recent HbA1c".value as FHIR.Quantity).value

define "HbA1c Missing":
  "Most Recent HbA1c" is null

define "Numerator":
  "Initial Population"
    and not "Denominator Exclusions"
    and ("HbA1c Missing" or "Most Recent HbA1c Value" > 9.0)

// 5-bucket headline (the harness reads the raw gate defines above for per-subject divergence).
define "Outcome Status":
  if not "Initial Population" then 'MISSING_DATA'
  else if "Denominator Exclusions" then 'EXCLUDED'
  else if "Numerator" then 'OVERDUE'
  else 'COMPLIANT'
```

- [ ] **Step 2: Compile the CQL to ELM**

Run: `corepack pnpm -C backend-ts compile-measures`
Expected: prints `compiled N measures + FHIRHelpers …` with N one higher than before; creates `backend-ts/src/engine/cql/elm/DiabetesHbA1cPoorControlOfficialCQL-1.0.0.elm.json` and adds it to `elm/index.ts`. If it throws "CQL translation errors in cms122_official.cql", fix the CQL and re-run.

- [ ] **Step 3: Write the failing engine `metaOverride` + official-meta test**

Create `backend-ts/src/standards/cms122-official.ts`:

```ts
/**
 * E14 PR-3 — the official-subset CMS122 measure as an inline engine meta, kept OUT of the MEASURES
 * registry (which seed:scale / quality backfill / segment+order tests iterate — must not be polluted).
 * The library id matches the CQL header in measures/cms122_official.cql. Value sets are the official
 * VSAC OIDs (resolved from the imported value_sets rows by StoreValueSetResolver). Descriptive only.
 */
import type { MeasureMeta } from "../engine/cql/measure-registry.ts";

/** OID probed to decide real-execution vs the PR-2 estimate (Diabetes value set). */
export const CMS122_DIABETES_OID = "2.16.840.1.113883.3.464.1003.103.12.1001";
export const CMS122_HBA1C_OID = "2.16.840.1.113883.3.464.1003.198.12.1013";
export const CMS122_QUALIFYING_VISIT_OIDS = [
  "2.16.840.1.113883.3.464.1003.101.12.1001",
  "2.16.840.1.113883.3.526.3.1240",
  "2.16.840.1.113883.3.464.1003.101.12.1025",
  "2.16.840.1.113883.3.464.1003.101.12.1023",
  "2.16.840.1.113883.3.464.1003.101.12.1016",
  "2.16.840.1.113883.3.464.1003.101.12.1080",
  "2.16.840.1.113883.3.464.1003.1006",
];
export const CMS122_HOSPICE_OID = "2.16.840.1.113883.3.464.1003.1003";
export const CMS122_PALLIATIVE_OID = "2.16.840.1.113883.3.464.1003.1167";

/** Inline meta for the official-subset measure (never registered in MEASURES). */
export const CMS122_OFFICIAL_META: MeasureMeta = {
  id: "cms122_official",
  name: "CMS122v14 Official-Subset (Diagnostic)",
  library: "DiabetesHbA1cPoorControlOfficialCQL-1.0.0",
  expansionLibrary: "DiabetesHbA1cPoorControlOfficialCQL-1.0.0",
  valueSets: [
    CMS122_DIABETES_OID,
    CMS122_HBA1C_OID,
    ...CMS122_QUALIFYING_VISIT_OIDS,
    CMS122_HOSPICE_OID,
    CMS122_PALLIATIVE_OID,
  ],
  periodMonths: 12,
};
```

Create `backend-ts/src/standards/cms122-official.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { CMS122_OFFICIAL_META, CMS122_DIABETES_OID, CMS122_HBA1C_OID } from "./cms122-official.ts";
import type { ValueSetResolver } from "../engine/cql/value-set-resolver.ts";

// A fixture resolver: real member codings we stamp on the hand-built bundles below.
const DIABETES_CODE = { code: "44054006", system: "http://snomed.info/sct" };
const HBA1C_CODE = { code: "4548-4", system: "http://loinc.org" };
const OFFICE_VISIT_CODE = { code: "99213", system: "http://www.ama-assn.org/go/cpt" };
const fixtureResolver: ValueSetResolver = {
  expand: (oid) =>
    Promise.resolve(
      oid === CMS122_DIABETES_OID ? [DIABETES_CODE]
      : oid === CMS122_HBA1C_OID ? [HBA1C_CODE]
      : oid === "2.16.840.1.113883.3.464.1003.101.12.1001" ? [OFFICE_VISIT_CODE]
      : [],
    ),
};

function bundle(parts: {
  birthDate: string; visit?: boolean; diabetes?: boolean; hba1c?: number | "missing" | null;
}): unknown {
  const entry: Array<{ resource: unknown }> = [
    { resource: { resourceType: "Patient", id: "p1", birthDate: parts.birthDate } },
  ];
  if (parts.visit) entry.push({ resource: { resourceType: "Encounter", id: "e1", status: "finished", subject: { reference: "Patient/p1" }, type: [{ coding: [OFFICE_VISIT_CODE] }], period: { start: "2026-03-01T00:00:00" } } });
  if (parts.diabetes) entry.push({ resource: { resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" }, code: { coding: [DIABETES_CODE] } } });
  if (parts.hba1c != null && parts.hba1c !== "missing") entry.push({ resource: { resourceType: "Observation", id: "o1", status: "final", subject: { reference: "Patient/p1" }, code: { coding: [HBA1C_CODE] }, effectiveDateTime: "2026-04-01T00:00:00", valueQuantity: { value: parts.hba1c, unit: "%", system: "http://unitsofmeasure.org", code: "%" } } });
  return { resourceType: "Bundle", type: "collection", entry };
}

async function evalOfficial(b: unknown, evalDate = "2026-06-30") {
  const engine = new CqlExecutionEngine({ valueSetResolver: fixtureResolver });
  return engine.evaluate({ measureId: "cms122_official", metaOverride: CMS122_OFFICIAL_META, patientBundle: b, evaluationDate: evalDate });
}
function define(o: Awaited<ReturnType<typeof evalOfficial>>, name: string): unknown {
  return o.evidence.expressionResults.find((e) => e.define === name)?.result;
}

test("official CMS122: in-IPP, HbA1c 7 → COMPLIANT", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 7 }));
  assert.equal(define(o, "Initial Population"), true);
  assert.equal(o.outcome, "COMPLIANT");
});
test("official CMS122: in-IPP, HbA1c 10 → OVERDUE (numerator)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 10 }));
  assert.equal(o.outcome, "OVERDUE");
});
test("official CMS122: in-IPP, HbA1c missing → OVERDUE (missing counts as numerator)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: "missing" }));
  assert.equal(define(o, "HbA1c Missing"), true);
  assert.equal(o.outcome, "OVERDUE");
});
test("official CMS122: no qualifying visit → NOT in IPP", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: false, diabetes: true, hba1c: 7 }));
  assert.equal(define(o, "Has Qualifying Visit"), false);
  assert.equal(define(o, "Initial Population"), false);
});
test("official CMS122: age 80 → NOT in IPP", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1944-01-01", visit: true, diabetes: true, hba1c: 7 }));
  assert.equal(define(o, "Age 18 To 75"), false);
  assert.equal(define(o, "Initial Population"), false);
});
```

- [ ] **Step 4: Run the test — expect FAIL (metaOverride not yet supported)**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "official CMS122"`
Expected: FAIL — `evaluate` ignores `metaOverride` and throws `unknown measure 'cms122_official'`.

- [ ] **Step 5: Add `metaOverride` to the engine (minimal, backward-compatible)**

In `backend-ts/src/engine/cql/cql-execution-engine.ts`, add the import and change the meta lookup. Import `MeasureMeta`:

```ts
import { MEASURES, type MeasureMeta } from "./measure-registry.ts";
```

Change the `evaluate` signature + first lines (currently lines 73-75):

```ts
  async evaluate(input: EvaluateMeasureInput & { elm?: unknown; metaOverride?: MeasureMeta }): Promise<MeasureOutcome> {
    const meta = input.metaOverride ?? MEASURES[input.measureId];
    if (!meta) throw new Error(`unknown measure '${input.measureId}'`);
```

Everything else in `evaluate` is unchanged (it already reads `meta.expansionLibrary`, `meta.valueSets`, `meta.periodMonths`, `meta.name`).

- [ ] **Step 6: Run the test — expect PASS**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "official CMS122"`
Expected: PASS (all 5).

- [ ] **Step 7: Full suite + typecheck (no regression in the 962 existing tests)**

Run: `corepack pnpm -C backend-ts typecheck && corepack pnpm -C backend-ts test`
Expected: typecheck clean; all pass (1 pg-skip). The two MEASURES-iterating golden tests are unaffected (cms122_official is not in MEASURES).

- [ ] **Step 8: Commit**

```bash
git add backend-ts/measures/cms122_official.cql backend-ts/src/engine/cql/elm/ backend-ts/src/engine/cql/cql-execution-engine.ts backend-ts/src/standards/cms122-official.ts backend-ts/src/standards/cms122-official.test.ts
git commit -m "feat(e14): official-subset CMS122 CQL + engine metaOverride seam (PR-3 task 1)"
```

---

## Task 2: `enrichForOfficialCms122` transform + ADR-008 guard

**Files:**
- Modify: `backend-ts/src/standards/cms122-official.ts` (add the enrichment transform)
- Create/extend: `backend-ts/src/standards/cms122-official.test.ts` (enrichment + ADR-008 guard)

The transform additively injects real VSAC-member codings + resources so the official gates fire, deterministically per `externalId`. It takes the resolved expansions (a `Map<oid, CqlCode[]>`) so the codes it stamps are guaranteed members of the same sets the official measure resolves against (closed loop). It **never removes** existing codings, so WorkWell's `urn:workwell:*`-matching cms122 stays byte-identical.

- [ ] **Step 1: Write the failing enrichment + ADR-008 guard test**

Append to `backend-ts/src/standards/cms122-official.test.ts`:

```ts
import { enrichForOfficialCms122, type Expansions } from "./cms122-official.ts";
import { CMS122_QUALIFYING_VISIT_OIDS, CMS122_HOSPICE_OID, CMS122_PALLIATIVE_OID } from "./cms122-official.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { seededTargetFor } from "../run/distribution.ts";

const EXPANSIONS: Expansions = new Map([
  [CMS122_DIABETES_OID, [DIABETES_CODE]],
  [CMS122_HBA1C_OID, [HBA1C_CODE]],
  [CMS122_QUALIFYING_VISIT_OIDS[0]!, [OFFICE_VISIT_CODE]],
  [CMS122_HOSPICE_OID, [{ code: "183919006", system: "http://snomed.info/sct" }]],
  [CMS122_PALLIATIVE_OID, [{ code: "103735009", system: "http://snomed.info/sct" }]],
]);

function cms122Bundle(externalId: string, today = "2026-06-30") {
  const employee = EMPLOYEES.find((e) => e.externalId === externalId)!;
  const binding = MEASURE_BINDINGS["cms122"]!;
  const target = seededTargetFor(EMPLOYEES, binding.rateKey, externalId) ?? "MISSING_DATA";
  const config = deriveExamConfig(binding, target);
  return { employee, base: buildSyntheticBundle(employee, config, today) };
}

test("enrichment appends the diabetes VSAC coding without removing the urn:workwell coding", () => {
  const { employee, base } = cms122Bundle(EMPLOYEES[0]!.externalId);
  const enriched = enrichForOfficialCms122(structuredClone(base), employee, EXPANSIONS);
  const conds = (enriched.entry as Array<{ resource: { resourceType: string; code?: { coding: Array<{ system: string; code: string }> } } }>)
    .filter((e) => e.resource.resourceType === "Condition");
  const diabetes = conds.find((c) => c.resource.code?.coding.some((x) => x.system === "urn:workwell:vs:cms122-diabetes"));
  // urn:workwell coding preserved AND the VSAC member coding appended (only if the base has a diabetes Condition)
  if (diabetes) {
    assert.ok(diabetes.resource.code!.coding.some((x) => x.system === DIABETES_CODE.system && x.code === DIABETES_CODE.code));
  }
});

test("ADR-008 guard: WorkWell cms122 outcome is byte-identical on enriched vs un-enriched bundle", async () => {
  const { CqlExecutionEngine } = await import("../engine/cql/cql-execution-engine.ts");
  const engine = new CqlExecutionEngine();
  for (const emp of EMPLOYEES.slice(0, 30)) {
    const { employee, base } = cms122Bundle(emp.externalId);
    const enriched = enrichForOfficialCms122(structuredClone(base), employee, EXPANSIONS);
    const a = await engine.evaluate({ measureId: "cms122", patientBundle: base, evaluationDate: "2026-06-30" });
    const b = await engine.evaluate({ measureId: "cms122", patientBundle: enriched, evaluationDate: "2026-06-30" });
    assert.equal(b.outcome, a.outcome, `WorkWell cms122 outcome changed by enrichment for ${emp.externalId}`);
  }
});
```

- [ ] **Step 2: Run — expect FAIL (`enrichForOfficialCms122` not exported)**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "enrichment|ADR-008 guard"`
Expected: FAIL — `enrichForOfficialCms122`/`Expansions` are not exported.

- [ ] **Step 3: Implement the enrichment transform**

Append to `backend-ts/src/standards/cms122-official.ts`:

```ts
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import type { CqlCode } from "../engine/cql/value-set-resolver.ts";

export type Expansions = Map<string, CqlCode[]>;

/** Stable per-subject hash → deterministic gate assignment (visit/age/exclusion divergence subsets). */
function hash(externalId: string): number {
  let h = 0;
  for (const ch of externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const first = (ex: Expansions, oid: string): CqlCode | null => ex.get(oid)?.[0] ?? null;

const isType = (r: { resourceType?: string }, t: string) => r.resourceType === t;

/**
 * Additively enrich a subject's synthetic bundle so the official-subset CMS122 gates fire. Real
 * VSAC-member codings sampled from `expansions` (the same sets the official measure resolves) are
 * APPENDED — never replacing existing `urn:workwell:*` codings — so WorkWell's cms122 outcome is
 * unchanged (ADR-008 guard test). Deterministic per externalId. Mutates + returns `bundle`.
 */
export function enrichForOfficialCms122(bundle: FhirBundle, employee: EmployeeProfile, expansions: Expansions): FhirBundle {
  const h = hash(employee.externalId);
  const entries = bundle.entry as Array<{ resource: Record<string, unknown> }>;

  // 1) Append the VSAC diabetes coding onto the existing diabetes Condition (urn:workwell code preserved).
  const diabetesCode = first(expansions, CMS122_DIABETES_OID);
  if (diabetesCode) {
    for (const e of entries) {
      const r = e.resource as { resourceType?: string; code?: { coding?: CqlCode[] } };
      if (isType(r, "Condition") && r.code?.coding?.some((c) => c.system === "urn:workwell:vs:cms122-diabetes")) {
        r.code.coding!.push({ ...diabetesCode });
      }
    }
  }
  // 2) Append the VSAC HbA1c coding onto the existing HbA1c Observation.
  const hba1cCode = first(expansions, CMS122_HBA1C_OID);
  if (hba1cCode) {
    for (const e of entries) {
      const r = e.resource as { resourceType?: string; code?: { coding?: CqlCode[] } };
      if (isType(r, "Observation") && r.code?.coding?.some((c) => c.system === "urn:workwell:vs:cms122-hba1c")) {
        r.code.coding!.push({ ...hba1cCode });
      }
    }
  }
  // 3) Qualifying visit: most subjects get one; a deterministic ~1/6 get NONE → age/visit divergence.
  const visitCode = first(expansions, CMS122_QUALIFYING_VISIT_OIDS[0]!);
  if (visitCode && h % 6 !== 0) {
    entries.push({ resource: {
      resourceType: "Encounter", id: `${employee.externalId}-enc-visit`, status: "finished",
      subject: { reference: `Patient/${employee.externalId}` },
      type: [{ coding: [{ ...visitCode }] }],
      period: { start: "2026-03-01T00:00:00", end: "2026-03-01T01:00:00" },
    } });
  }
  // 4) Age-out a deterministic ~1/10 (birthDate override is outcome-neutral for WorkWell → ADR-008 safe).
  if (h % 10 === 0) {
    const patient = entries.find((e) => (e.resource as { resourceType?: string }).resourceType === "Patient");
    if (patient) (patient.resource as { birthDate?: string }).birthDate = "1944-01-01";
  }
  // 5) Hospice exclusion for a deterministic ~1/12; palliative for a different ~1/12.
  const hospiceCode = first(expansions, CMS122_HOSPICE_OID);
  if (hospiceCode && h % 12 === 1) {
    entries.push({ resource: {
      resourceType: "Encounter", id: `${employee.externalId}-enc-hospice`, status: "finished",
      subject: { reference: `Patient/${employee.externalId}` },
      type: [{ coding: [{ ...hospiceCode }] }],
      period: { start: "2026-02-01T00:00:00", end: "2026-02-05T00:00:00" },
    } });
  }
  const palliativeCode = first(expansions, CMS122_PALLIATIVE_OID);
  if (palliativeCode && h % 12 === 2) {
    entries.push({ resource: {
      resourceType: "Condition", id: `${employee.externalId}-cond-palliative`,
      subject: { reference: `Patient/${employee.externalId}` },
      code: { coding: [{ ...palliativeCode }] },
    } });
  }
  return bundle;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "enrichment|ADR-008 guard"`
Expected: PASS. If the ADR-008 guard fails, the enrichment is replacing (not appending) a coding — fix so existing codings are preserved.

- [ ] **Step 5: Typecheck + commit**

Run: `corepack pnpm -C backend-ts typecheck`
```bash
git add backend-ts/src/standards/cms122-official.ts backend-ts/src/standards/cms122-official.test.ts
git commit -m "feat(e14): harness-local CMS122 enrichment + ADR-008 byte-identical guard (PR-3 task 2)"
```

---

## Task 3: Execution diff harness (`execution-diff.ts`)

**Files:**
- Create: `backend-ts/src/standards/execution-diff.ts`
- Create: `backend-ts/src/standards/execution-diff.test.ts`

The harness: for each subject in the latest cms122 run, build → enrich → evaluate WorkWell cms122 fresh + official fresh → diff, attributing divergence to the first differing gate. Memoized per run-id.

- [ ] **Step 1: Write the failing harness test**

Create `backend-ts/src/standards/execution-diff.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeExecutionDiff, __clearExecutionDiffCache } from "./execution-diff.ts";
import { CMS122_DIABETES_OID, CMS122_HBA1C_OID, CMS122_QUALIFYING_VISIT_OIDS, CMS122_HOSPICE_OID, CMS122_PALLIATIVE_OID } from "./cms122-official.ts";
import { CMS122V14 } from "./references/cms122v14.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { ValueSetResolver } from "../engine/cql/value-set-resolver.ts";

const RESOLVER: ValueSetResolver = {
  expand: (oid) =>
    Promise.resolve(
      oid === CMS122_DIABETES_OID ? [{ code: "44054006", system: "http://snomed.info/sct" }]
      : oid === CMS122_HBA1C_OID ? [{ code: "4548-4", system: "http://loinc.org" }]
      : oid === CMS122_QUALIFYING_VISIT_OIDS[0] ? [{ code: "99213", system: "http://www.ama-assn.org/go/cpt" }]
      : oid === CMS122_HOSPICE_OID ? [{ code: "183919006", system: "http://snomed.info/sct" }]
      : oid === CMS122_PALLIATIVE_OID ? [{ code: "103735009", system: "http://snomed.info/sct" }]
      : [],
    ),
};

// Latest-run rows: subjectId + WorkWell status. Use the real synthetic cohort.
const rows = EMPLOYEES.slice(0, 40).map((e) => ({ subjectId: e.externalId, status: "MISSING_DATA", runId: "run-1", runStartedAt: "2026-06-30T00:00:00Z" }));

test("execution diff: produces per-subject rows and a divergent count tied to the run", async () => {
  __clearExecutionDiffCache();
  const report = await computeExecutionDiff(CMS122V14, rows, {
    engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }),
    resolver: RESOLVER,
    employees: EMPLOYEES,
    today: "2026-06-30",
    asOf: "2026-06-30",
  });
  assert.equal(report.mode, "execution");
  assert.equal(report.runId, "run-1");
  assert.equal(report.subjects.length, rows.length);
  // At least one subject diverges (missing-HbA1c counts as numerator in the official measure; age/visit/exclusion gates).
  assert.ok(report.totalDivergent >= 1);
  // Every divergent subject carries a gate attribution.
  for (const s of report.subjects.filter((x) => x.diverged)) assert.ok(s.divergenceGate.length > 0);
});

test("execution diff: memoized per run-id (second call reuses the cached report)", async () => {
  __clearExecutionDiffCache();
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30" };
  const r1 = await computeExecutionDiff(CMS122V14, rows, deps);
  const r2 = await computeExecutionDiff(CMS122V14, rows, deps);
  assert.equal(r1, r2, "same object returned from cache for the same runId");
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "execution diff"`
Expected: FAIL — cannot find `./execution-diff.ts`.

- [ ] **Step 3: Implement the harness**

Create `backend-ts/src/standards/execution-diff.ts`:

```ts
/**
 * E14 PR-3 — real subject-by-subject execution diff for CMS122. For each subject in the latest
 * population run: build the synthetic bundle, additively enrich it with real VSAC-member codes, evaluate
 * BOTH WorkWell's authored cms122 AND the official-subset measure fresh, and diff — attributing each
 * divergence to the first differing official gate. Memoized per run-id (terminal runs are immutable).
 * Descriptive only (ADR-008): writes nothing; never sets a stored outcome.
 */
import type { OfficialMeasureReference } from "./reference-types.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { ValueSetResolver, CqlCode } from "../engine/cql/value-set-resolver.ts";
import { CMS122_OFFICIAL_META, enrichForOfficialCms122, type Expansions } from "./cms122-official.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { seededTargetFor } from "../run/distribution.ts";

export interface DiffEngine {
  evaluate(input: { measureId: string; metaOverride?: unknown; patientBundle: unknown; evaluationDate?: string }): Promise<{ outcome: string; evidence: { expressionResults: Array<{ define: string; result: unknown }> } }>;
}
export interface ExecutionDiffDeps {
  engine: DiffEngine;
  resolver: ValueSetResolver;
  employees: readonly EmployeeProfile[];
  today: string; // anchors synthetic events
  asOf: string;  // evaluation date (the run date)
}
export interface SubjectDiff {
  subjectId: string;
  workwellOutcome: string;
  officialOutcome: string;
  diverged: boolean;
  /** First official gate that explains the divergence (empty when not diverged). */
  divergenceGate: string;
}
export interface ExecutionDiffReport {
  mode: "execution";
  measureId: string;
  ecqmId: string;
  runId: string | null;
  asOf: string | null;
  totalSubjectsEvaluated: number;
  totalDivergent: number;
  /** Count of divergent subjects grouped by gate. */
  byGate: Record<string, number>;
  subjects: SubjectDiff[];
  headline: string;
  disclaimer: string;
}

type Row = { subjectId: string; status: string; runId: string; runStartedAt: string };

const DISCLAIMER =
  "Real execution diff: an official-SUBSET CMS122 (faithful-but-simplified transcription, FHIR-model, " +
  "driven by the imported VSAC value sets) evaluated per subject against WorkWell's authored measure. " +
  "Not the literal multi-library QICore artifact (un-compilable under the pinned JVM-free translator). " +
  "Descriptive only — CQL Outcome Status remains the sole compliance authority (ADR-008).";

const def = (evidence: { expressionResults: Array<{ define: string; result: unknown }> }, name: string): unknown =>
  evidence.expressionResults.find((e) => e.define === name)?.result;

/** Which official gate removed / reclassified this subject relative to WorkWell (first that applies). */
function attributeGate(ev: { expressionResults: Array<{ define: string; result: unknown }> }): string {
  if (def(ev, "Age 18 To 75") === false) return "age-18-75";
  if (def(ev, "Has Qualifying Visit") === false) return "qualifying-visit";
  if (def(ev, "Has Diabetes") === false) return "diabetes-diagnosis";
  if (def(ev, "Has Hospice") === true) return "hospice";
  if (def(ev, "Has Palliative") === true) return "palliative-care";
  if (def(ev, "HbA1c Missing") === true) return "hba1c-missing-counts-numerator";
  return "numerator-threshold";
}

const cache = new Map<string, ExecutionDiffReport>();
/** @internal test hook */
export function __clearExecutionDiffCache(): void {
  cache.clear();
}

export async function computeExecutionDiff(
  ref: OfficialMeasureReference,
  rows: Row[],
  deps: ExecutionDiffDeps,
): Promise<ExecutionDiffReport> {
  const runId = rows[0]?.runId ?? null;
  const asOf = rows[0]?.runStartedAt?.slice(0, 10) ?? deps.asOf;
  if (runId && cache.has(runId)) return cache.get(runId)!;

  // Resolve the official value sets once (closed loop: enrichment samples from the same expansions).
  const expansions: Expansions = new Map<string, CqlCode[]>();
  for (const oid of CMS122_OFFICIAL_META.valueSets ?? []) expansions.set(oid, await deps.resolver.expand(oid));

  const binding = MEASURE_BINDINGS["cms122"]!;
  const subjects: SubjectDiff[] = [];
  const byGate: Record<string, number> = {};

  for (const row of rows) {
    const employee = deps.employees.find((e) => e.externalId === row.subjectId);
    if (!employee) continue; // scale/encoded subjects are excluded upstream; skip any stray id
    try {
      const target = seededTargetFor(deps.employees, binding.rateKey, row.subjectId) ?? "MISSING_DATA";
      const config = deriveExamConfig(binding, target);
      const base = buildSyntheticBundle(employee, config, deps.today);
      const enriched = enrichForOfficialCms122(base, employee, expansions);
      const workwell = await deps.engine.evaluate({ measureId: "cms122", patientBundle: enriched, evaluationDate: deps.asOf });
      const official = await deps.engine.evaluate({ measureId: "cms122_official", metaOverride: CMS122_OFFICIAL_META, patientBundle: enriched, evaluationDate: deps.asOf });
      const diverged = official.outcome !== workwell.outcome;
      const gate = diverged ? attributeGate(official.evidence) : "";
      if (diverged) byGate[gate] = (byGate[gate] ?? 0) + 1;
      subjects.push({ subjectId: row.subjectId, workwellOutcome: workwell.outcome, officialOutcome: official.outcome, diverged, divergenceGate: gate });
    } catch {
      // A per-subject failure must not abort the diff (mirrors the run pipeline's per-subject guard).
      subjects.push({ subjectId: row.subjectId, workwellOutcome: row.status, officialOutcome: "ERROR", diverged: false, divergenceGate: "" });
    }
  }

  const totalDivergent = subjects.filter((s) => s.diverged).length;
  const report: ExecutionDiffReport = {
    mode: "execution",
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    runId,
    asOf,
    totalSubjectsEvaluated: subjects.length,
    totalDivergent,
    byGate,
    subjects,
    headline:
      `Executed the official-subset ${ref.ecqmId} against ${subjects.length} subjects of the latest ` +
      `${ref.measureId} run: ${totalDivergent} would have a different outcome under the official ` +
      `age/visit/exclusion/numerator criteria.`,
    disclaimer: DISCLAIMER,
  };
  if (runId) cache.set(runId, report);
  return report;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "execution diff"`
Expected: PASS (2). If `totalDivergent` is 0, confirm the resolver stubs return non-empty member codes for the qualifying-visit OID (so the gate logic exercises).

- [ ] **Step 5: Typecheck + commit**

Run: `corepack pnpm -C backend-ts typecheck`
```bash
git add backend-ts/src/standards/execution-diff.ts backend-ts/src/standards/execution-diff.test.ts
git commit -m "feat(e14): CMS122 execution diff harness (build→enrich→eval both→diff) (PR-3 task 3)"
```

---

## Task 4: Route wiring + degrade fallback

**Files:**
- Modify: `backend-ts/src/routes/measures.ts:442-450` (the `/fidelity/diff` handler)
- Create: `backend-ts/src/routes/measures-fidelity-diff.test.ts` (route-level degrade + execution)

- [ ] **Step 1: Write the failing route test**

Create `backend-ts/src/routes/measures-fidelity-diff.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseDiffMode } from "./measures.ts";

test("chooseDiffMode: empty diabetes expansion → estimate", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([]) });
  assert.equal(mode, "estimate");
});
test("chooseDiffMode: non-empty diabetes expansion → execution", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([{ code: "44054006", system: "http://snomed.info/sct" }]) });
  assert.equal(mode, "execution");
});
```

- [ ] **Step 2: Run — expect FAIL (`chooseDiffMode` not exported)**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "chooseDiffMode"`
Expected: FAIL.

- [ ] **Step 3: Wire the route**

In `backend-ts/src/routes/measures.ts`, add imports near the other standards imports (around line 62-64):

```ts
import { computeExecutionDiff } from "../standards/execution-diff.ts";
import { CMS122_DIABETES_OID } from "../standards/cms122-official.ts";
import { StoreValueSetResolver, type ValueSetResolver } from "../engine/cql/value-set-resolver.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
```

Add the exported helper (module scope, near the other helpers):

```ts
/** Execution diff only when the official VSAC value sets are importable from the store (probe Diabetes). */
export async function chooseDiffMode(resolver: ValueSetResolver): Promise<"execution" | "estimate"> {
  const codes = await resolver.expand(CMS122_DIABETES_OID);
  return codes.length > 0 ? "execution" : "estimate";
}
```

Replace the diff handler body (currently lines 443-450) with:

```ts
  if (diffId && req.method === "GET") {
    const ref = referenceFor(diffId);
    if (!ref) return json({ available: false });
    const stores = await getStores(env);
    const allOutcomes = await stores.outcomes.listOutcomesWithRun({ measureId: diffId, excludeScale: true });
    const latestRows = latestRunRows(allOutcomes.filter((o) => isPopulationRun(o.runScopeType) && isCompletedRun(o.runStatus)));
    const resolver = new StoreValueSetResolver(stores.valueSets);
    // Execution diff only for cms122 and only when the imported VSAC rows are present; else the PR-2 estimate.
    if (diffId === "cms122" && (await chooseDiffMode(resolver)) === "execution") {
      const today = new Date().toISOString().slice(0, 10);
      const asOf = latestRows[0]?.runStartedAt?.slice(0, 10) ?? today;
      const report = await computeExecutionDiff(ref, latestRows, {
        engine: new CqlExecutionEngine({ valueSetResolver: resolver }),
        resolver, employees: EMPLOYEES, today, asOf,
      });
      return json(report);
    }
    return json(computeOutcomeDiff(ref, latestRows, new Date().getUTCFullYear()));
  }
```

> Note: `latestRunRows` returns rows with `subjectId`, `status`, `runId`, `runStartedAt` — matching both `computeOutcomeDiff`'s `OutcomeSlice` and the harness `Row`. If TypeScript complains the row type is wider, map to `{ subjectId, status, runId, runStartedAt }` before passing.

- [ ] **Step 4: Run — expect PASS**

Run: `corepack pnpm -C backend-ts test -- --test-name-pattern "chooseDiffMode"`
Expected: PASS (2).

- [ ] **Step 5: Full suite + typecheck**

Run: `corepack pnpm -C backend-ts typecheck && corepack pnpm -C backend-ts test`
Expected: typecheck clean; all pass (1 pg-skip). The existing PR-2 `outcome-diff.test.ts` still passes (that path is the fallback, unchanged).

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/routes/measures.ts backend-ts/src/routes/measures-fidelity-diff.test.ts
git commit -m "feat(e14): /fidelity/diff runs execution diff when VSAC rows present, else estimate (PR-3 task 4)"
```

---

## Task 5: Standards-tab UI — render per-subject execution divergence

**Files:**
- Modify: `frontend/features/studio/components/StandardsTab.tsx`
- Modify: `frontend/features/studio/components/__tests__/StandardsTab.test.tsx`

The `/fidelity/diff` response is now one of two shapes: the PR-2 estimate (`{ criterionImpacts, ... }`) or the new execution report (`{ mode: "execution", subjects, byGate, totalDivergent, headline, disclaimer, ... }`). The component must render both (discriminate on `mode === "execution"`).

- [ ] **Step 1: Read the existing component + test to match its patterns**

Read `frontend/features/studio/components/StandardsTab.tsx` and its test. Note how it fetches `/fidelity/diff`, its loading/empty/`available:false` states, and its existing `criterionImpacts` table markup + typography/utility classes. Reuse those patterns (do not introduce new styling conventions).

- [ ] **Step 2: Write the failing UI test**

In `frontend/features/studio/components/__tests__/StandardsTab.test.tsx`, add a case that renders the component with a mocked execution-mode diff response:

```tsx
// mock fetch of /fidelity/diff to return:
const executionDiff = {
  mode: "execution", measureId: "cms122", ecqmId: "CMS122v14", runId: "run-1", asOf: "2026-06-30",
  totalSubjectsEvaluated: 3, totalDivergent: 2,
  byGate: { "qualifying-visit": 1, "hba1c-missing-counts-numerator": 1 },
  subjects: [
    { subjectId: "emp-001", workwellOutcome: "COMPLIANT", officialOutcome: "MISSING_DATA", diverged: true, divergenceGate: "qualifying-visit" },
    { subjectId: "emp-002", workwellOutcome: "MISSING_DATA", officialOutcome: "OVERDUE", diverged: true, divergenceGate: "hba1c-missing-counts-numerator" },
    { subjectId: "emp-003", workwellOutcome: "COMPLIANT", officialOutcome: "COMPLIANT", diverged: false, divergenceGate: "" },
  ],
  headline: "Executed the official-subset CMS122v14 against 3 subjects…",
  disclaimer: "Real execution diff…",
};
// assert: the headline renders, "2" divergent shows, and a row for emp-001 shows COMPLIANT → MISSING_DATA with gate "qualifying-visit".
```

Follow the existing test's render/query helpers (e.g. `@testing-library/react`, `screen.getByText`). Assert:
- `screen.getByText(/Executed the official-subset/)` present.
- The divergent count (`2`) is shown.
- A row/cell shows `emp-001`, `COMPLIANT`, `MISSING_DATA`, and `qualifying-visit`.

- [ ] **Step 3: Run — expect FAIL**

Run: `corepack pnpm -C frontend test -- StandardsTab`
Expected: FAIL (execution branch not rendered).

- [ ] **Step 4: Implement the execution-mode branch**

In `StandardsTab.tsx`, after fetching the diff, branch on `diff.mode === "execution"`:
- Render `diff.headline`, a `totalDivergent / totalSubjectsEvaluated` summary, and a `byGate` breakdown (gate → count).
- Render a table of `subjects` (reuse the existing table markup/classes): columns Subject, WorkWell outcome, Official outcome, Gate. Highlight rows where `diverged`.
- Render `diff.disclaimer` in the same muted style the PR-2 disclaimer uses.
- Keep the existing `criterionImpacts` rendering for the estimate shape (when `mode !== "execution"`), and the `available:false` empty state.
- Add a `ChartDataTable`/`sr-only` alternative only if the existing component already uses one; otherwise a plain semantic `<table>` with `scope="col"` headers (matches the repo's a11y pattern).

- [ ] **Step 5: Run — expect PASS**

Run: `corepack pnpm -C frontend test -- StandardsTab`
Expected: PASS.

- [ ] **Step 6: Lint + build + commit**

Run: `corepack pnpm -C frontend lint && corepack pnpm -C frontend build`
Expected: clean.
```bash
git add frontend/features/studio/components/StandardsTab.tsx frontend/features/studio/components/__tests__/StandardsTab.test.tsx
git commit -m "feat(e14): Standards tab renders CMS122 per-subject execution divergence (PR-3 task 5)"
```

---

## Task 6: Docs + verification pass

**Files:**
- Modify: `docs/MEASURES.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`

- [ ] **Step 1: MEASURES.md** — under the CMS122 section, replace the "E14 PR-3 follow-on / deferred" note with: PR-3 shipped a faithful official-**subset** execution diff (why not literal: the QICore multi-library artifact is un-compilable under `@cqframework/cql` 4.0.0-beta.1 cross-model modelinfo loading — spike 2026-07-05); GMI numerator remains a documented gap.

- [ ] **Step 2: ARCHITECTURE.md** — in the `standards` module description + the `/fidelity/diff` interface note, document the execution diff (build→enrich→evaluate both fresh→diff), the harness-local enrichment (out of the live run path), the store-backed VSAC resolution (no runtime key), the degrade-to-estimate fallback, and the ADR-008 invariant (writes nothing; WorkWell outcomes byte-identical). Note the engine `metaOverride` seam and that `cms122_official` is deliberately **not** in the `MEASURES` registry.

- [ ] **Step 3: DATA_MODEL.md** — add a short note (no schema): the execution diff is read-time; enrichment is harness-local synthetic data; the official measure resolves the imported `value_sets` (source='VSAC') rows.

- [ ] **Step 4: DECISIONS.md** — add an ADR (next number) "Official CMS122 fidelity via a faithful subset, not the literal QICore CQL": context (spike verdict — translator can't load cross-model QICore modelinfo; runtime engine links no multi-library graph), decision (FHIR-model subset, VSAC-store-driven, real execution diff, descriptive-only), consequences (revisit literal on a stable multi-model translator release; GMI gap).

- [ ] **Step 5: JOURNAL.md** — add a dated (2026-07-05) entry summarizing PR-3: spike → fallback → official-subset execution diff; files; test counts; no schema, no new deps.

- [ ] **Step 6: Full verification**

Run:
```bash
corepack pnpm -C backend-ts typecheck && corepack pnpm -C backend-ts test
corepack pnpm -C frontend lint && corepack pnpm -C frontend test && corepack pnpm -C frontend build
```
Expected: backend typecheck clean + all pass (1 pg-skip); frontend lint clean + tests pass + build succeeds.

- [ ] **Step 7: Drive the real surface (verify skill)** — with the local backend + frontend running, open a measure's Studio → **Standards** tab for CMS122 and confirm the execution diff renders (or, without imported VSAC rows locally, that it degrades to the estimate). Optionally hit `GET /api/measures/cms122/fidelity/diff` and confirm the `mode` field.

- [ ] **Step 8: Commit**

```bash
git add docs/
git commit -m "docs(e14): PR-3 official-subset execution diff — MEASURES/ARCHITECTURE/DATA_MODEL/DECISIONS/JOURNAL"
```

---

## Final steps (after all tasks)

- [ ] Whole-branch code review: run `superpowers:code-reviewer` on the full diff `main..feat/e14-pr3-official-execution-diff` (per the "always code-review every PR" rule).
- [ ] Address review findings.
- [ ] Push the branch and open a PR (do NOT auto-merge — Taleef reviews/merges). Ensure the CMS122 fidelity report / MEASURES currency is consistent.
- [ ] Optional: run `pnpm resolve-valuesets` is NOT needed again (prod Neon already has the 21 OIDs); the diff runs real on the demo stack immediately.
