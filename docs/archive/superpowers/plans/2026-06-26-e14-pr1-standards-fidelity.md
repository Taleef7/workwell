# E14 PR-1 — Standards fidelity diff (CMS122v14) + jurisdiction metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a documented, sourced **fidelity diff** of WorkWell's authored `cms122` measure against the official **CMS122v14** specification — a `GET /api/measures/cms122/fidelity` report (covered / simplified / omitted criteria + value-set fidelity) — plus a `jurisdiction` measure-metadata field and a country-aware design memo.

**Architecture:** A new `backend-ts/src/standards/` module, sitting beside (never inside) the engine. A **vendored, sourced** `OfficialMeasureReference` for CMS122v14 carries the official population criteria + the ~20 VSAC value sets + a **curated coverage** judgement (how WorkWell's authored CQL handles each). `computeFidelity(reference)` is a **pure assembler** → a `FidelityReport` with summary counts. A read-only route exposes it. No DB, no `node:fs` on the request path (Workers-portable), no engine call, no outcome mutation (the report is descriptive — ADR-008 holds). Official-CQL **execution** is explicitly deferred to PR-2.

**Tech Stack:** Backend TypeScript on `@mieweb/cloud`. Tests use `node:test` + `node:assert/strict`, run via `node --import tsx --test src/standards/<file>.test.ts`. Typecheck/full-suite from `backend-ts/` via `corepack pnpm@10 typecheck` / `corepack pnpm@10 test` (`pnpm` is on PATH only via `corepack`).

**Spec:** `docs/superpowers/specs/2026-06-26-e14-standards-fidelity-design.md`
**Branch:** `feat/e14-standards-fidelity` (the design is already committed here).

**Conventions:**
- Commit per task, conventional, scope `(e14)`, reference `#186`. Footer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- The `standards/` module must NOT import `node:fs`, the DB, or the CQL engine. It is pure data + pure functions (Workers-portable, on the request path).
- The report is **descriptive only** — it never sets/derives a compliance outcome (ADR-008). Every claim in the reference is sourced; cite the provenance URLs in a file-header comment.

**Verified facts (do not re-derive):**
- The measure route dispatcher is `handleMeasures(...)` in `backend-ts/src/routes/measures.ts`. Sibling sub-routes match a path then `getLatest(id)` for existence (404 if absent) — e.g. the `traceability` branch at lines 418–425 and the `detailId` catch-all at line 435. A new branch MUST be placed BEFORE the `detailId` catch-all (line 435) or it gets swallowed. Helpers in scope there: `store(env)` (measure store; `.getLatest(id)`), `json(data, status?)`.
- `MeasureMeta` is in `backend-ts/src/engine/cql/measure-registry.ts` (fields: `id, name, library, periodMonths, expansionLibrary?, valueSets?`). `MEASURES["cms122"].name = "Diabetes: Glycemic Status Assessment Greater Than 9%"`.
- The measure-detail read model is `toMeasureDetail(...)` → `MeasureDetail` in `backend-ts/src/measure/measure-read-models.ts`.
- WorkWell's authored `cms122` references 3 local value sets: `urn:workwell:vs:cms122-diabetes`, `urn:workwell:vs:cms122-hba1c`, `urn:workwell:vs:cms122-excluded` (see `backend-ts/measures/cms122.cql`).

---

## File Structure

**Create:**
- `backend-ts/src/standards/reference-types.ts` — the `OfficialMeasureReference` + criterion/value-set/coverage types.
- `backend-ts/src/standards/references/cms122v14.ts` — the vendored, sourced CMS122v14 reference.
- `backend-ts/src/standards/references/index.ts` — `referenceFor(measureId)` lookup.
- `backend-ts/src/standards/references/cms122v14.test.ts` — reference integrity.
- `backend-ts/src/standards/measure-fidelity.ts` — `computeFidelity` + `FidelityReport` types.
- `backend-ts/src/standards/measure-fidelity.test.ts`
- `docs/standards/country-aware-regulatory-sourcing.md` — the design memo.

**Modify:**
- `backend-ts/src/routes/measures.ts` — add the `GET /api/measures/:id/fidelity` branch.
- `backend-ts/src/routes/measures.test.ts` — endpoint test (if the file exists; else add a focused test file).
- `backend-ts/src/engine/cql/measure-registry.ts` — add `jurisdiction?: string` to `MeasureMeta`.
- `backend-ts/src/measure/measure-read-models.ts` — surface `jurisdiction` (default `"US"`) on `MeasureDetail`.
- Docs: `docs/STANDARDS_CONFORMANCE.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`.

---

## Task 1: Reference types + the vendored CMS122v14 reference

**Files:**
- Create: `backend-ts/src/standards/reference-types.ts`
- Create: `backend-ts/src/standards/references/cms122v14.ts`
- Create: `backend-ts/src/standards/references/index.ts`
- Create: `backend-ts/src/standards/references/cms122v14.test.ts`

- [ ] **Step 1: Create the types.** `backend-ts/src/standards/reference-types.ts`:

```ts
/**
 * Official eCQM measure-definition reference (E14 / #186). A sourced, structured transcription of an
 * officially published measure spec, used to diff WorkWell's authored (simplified) measure against it.
 * Descriptive only — never affects a compliance outcome (ADR-008). PR-1 is a STRUCTURAL diff; executing
 * the official CQL for an OUTCOME diff is PR-2 (deferred behind the E3.2 ValueSetResolver seam).
 */
export type Population = "IPP" | "DENOM" | "DENEX" | "NUMER" | "NUMEX";

/** How WorkWell's authored measure handles an official criterion. */
export type Coverage = "COVERED" | "SIMPLIFIED" | "OMITTED";

export interface OfficialValueSet {
  name: string;
  oid: string;
  /** Grouping tag used for the value-set fidelity view, e.g. "Diabetes", "HbA1c", "Hospice". */
  concept: string;
}

export interface OfficialCriterion {
  population: Population;
  /** Stable id, e.g. "age-18-75". */
  key: string;
  /** The official logic in plain terms (sourced). */
  description: string;
  /** OIDs this criterion references (subset of the measure's value sets). */
  valueSetOids: string[];
  /** How WorkWell's authored measure handles it (curated, sourced judgement). */
  coverage: Coverage;
  /** Grounded explanation of the coverage classification. */
  note: string;
}

/** Whether WorkWell's authored measure represents an official value-set concept. */
export interface WorkwellValueSetCoverage {
  concept: string;
  represented: boolean;
  /** The WorkWell (local) value set that represents it, if any. */
  workwellValueSet?: string;
  note: string;
}

export interface OfficialMeasureReference {
  /** WorkWell registry id this references, e.g. "cms122". */
  measureId: string;
  ecqmId: string;
  title: string;
  version: string;
  steward: string;
  scoring: string;
  provenance: { sourceUrl: string; frozenCodesUrl?: string; retrieved: string };
  criteria: OfficialCriterion[];
  valueSets: OfficialValueSet[];
  workwellValueSetCoverage: WorkwellValueSetCoverage[];
}
```

- [ ] **Step 2: Create the CMS122v14 reference.** `backend-ts/src/standards/references/cms122v14.ts`. Every field is transcribed from the official sources cited in the header — do not invent logic.

```ts
/**
 * Official CMS122v14 reference (E14 / #186) — "Diabetes: Glycemic Status Assessment Greater Than 9%",
 * eCQM version 14.0.000, steward NCQA, MIPS Quality ID 001, proportion (lower rate is better).
 * Transcribed from the official public sources (no VSAC login needed for these):
 *   - eCQI measure page:        https://ecqi.healthit.gov/ecqm/ec/2026/cms0122v14
 *   - Human-readable QDM HTML:  https://ecqi.healthit.gov/sites/default/files/ecqm/measures/CMS122-v14.0.000-QDM.html
 *   - QPP MIPS spec (frozen codes): https://qpp.cms.gov/docs/QPP_quality_measure_specifications/CQM-Measures/2026_Measure_001_MIPSCQM.pdf
 * Descriptive reference only — never affects a compliance outcome (ADR-008).
 */
import type { OfficialMeasureReference } from "../reference-types.ts";

export const CMS122V14: OfficialMeasureReference = {
  measureId: "cms122",
  ecqmId: "CMS122v14",
  title: "Diabetes: Glycemic Status Assessment Greater Than 9%",
  version: "14.0.000",
  steward: "NCQA",
  scoring: "proportion",
  provenance: {
    sourceUrl: "https://ecqi.healthit.gov/ecqm/ec/2026/cms0122v14",
    frozenCodesUrl: "https://qpp.cms.gov/docs/QPP_quality_measure_specifications/CQM-Measures/2026_Measure_001_MIPSCQM.pdf",
    retrieved: "2026-06-26",
  },
  criteria: [
    {
      population: "IPP",
      key: "age-18-75",
      description: "Patients 18–75 years of age by the end of the measurement period.",
      valueSetOids: [],
      coverage: "OMITTED",
      note: "WorkWell's cms122.cql applies no age restriction — it evaluates any subject with a diabetes diagnosis.",
    },
    {
      population: "IPP",
      key: "diabetes-diagnosis",
      description: "Patients with a diagnosis of diabetes overlapping the measurement period.",
      valueSetOids: ["2.16.840.1.113883.3.464.1003.103.12.1001"],
      coverage: "SIMPLIFIED",
      note: "WorkWell models diabetes via the local value set urn:workwell:vs:cms122-diabetes (a single demo code), not the official VSAC Diabetes value set.",
    },
    {
      population: "IPP",
      key: "qualifying-visit",
      description: "A qualifying encounter during the measurement period (office visit, annual wellness, preventive care 18+, home health, or telephone visit).",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.101.12.1001",
        "2.16.840.1.113883.3.526.3.1240",
        "2.16.840.1.113883.3.464.1003.101.12.1025",
        "2.16.840.1.113883.3.464.1003.101.12.1023",
        "2.16.840.1.113883.3.464.1003.101.12.1016",
        "2.16.840.1.113883.3.464.1003.101.12.1080",
      ],
      coverage: "OMITTED",
      note: "WorkWell has no encounter/visit requirement — diagnosis presence alone qualifies a subject.",
    },
    {
      population: "DENOM",
      key: "denominator-equals-ipp",
      description: "Denominator equals the Initial Population.",
      valueSetOids: [],
      coverage: "SIMPLIFIED",
      note: "WorkWell's denominator is effectively 'has diabetes diagnosis' (its Initial Population), without the age/visit gating.",
    },
    {
      population: "DENEX",
      key: "hospice",
      description: "Patients in hospice care for any part of the measurement period.",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.1003",
        "2.16.840.1.113762.1.4.1108.15",
        "2.16.840.1.113883.3.464.1003.1165",
      ],
      coverage: "OMITTED",
      note: "WorkWell has only one generic 'Has Exclusion' define (local urn:workwell:vs:cms122-excluded); it does not model hospice specifically.",
    },
    {
      population: "DENEX",
      key: "long-term-care-66",
      description: "Patients 66+ by end of the measurement period living long-term in a nursing home on or before the end of the period.",
      valueSetOids: ["2.16.840.1.113883.3.464.1003.101.12.1012"],
      coverage: "OMITTED",
      note: "Not modeled by WorkWell's single generic exclusion.",
    },
    {
      population: "DENEX",
      key: "advanced-illness-frailty-66",
      description: "Patients 66+ with frailty during the period who also meet advanced-illness criteria (two outpatient or one inpatient advanced-illness encounter in the period or the year prior, or taking dementia medications).",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.113.12.1074",
        "2.16.840.1.113883.3.464.1003.118.12.1300",
        "2.16.840.1.113883.3.464.1003.101.12.1088",
        "2.16.840.1.113883.3.464.1003.113.12.1075",
        "2.16.840.1.113883.3.464.1003.110.12.1082",
        "2.16.840.1.113883.3.464.1003.196.12.1510",
      ],
      coverage: "OMITTED",
      note: "Not modeled by WorkWell's single generic exclusion.",
    },
    {
      population: "DENEX",
      key: "palliative-care",
      description: "Patients receiving palliative care for any part of the measurement period.",
      valueSetOids: [
        "2.16.840.1.113883.3.464.1003.1167",
        "2.16.840.1.113883.3.464.1003.101.12.1090",
        "2.16.840.1.113883.3.464.1003.198.12.1135",
      ],
      coverage: "OMITTED",
      note: "Not modeled by WorkWell's single generic exclusion.",
    },
    {
      population: "NUMER",
      key: "hba1c-gmi-gt9-or-missing",
      description: "Most recent glycemic status assessment (HbA1c or GMI) during the period is > 9.0%, OR is missing / not performed during the period (missing counts as numerator).",
      valueSetOids: ["2.16.840.1.113883.3.464.1003.198.12.1013"],
      coverage: "SIMPLIFIED",
      note: "WorkWell covers the > 9% poor-control numerator (Overdue) and the missing-result case (Missing Data) using the local HbA1c value set, but does not model the GMI alternative and uses a demo value set rather than the official VSAC HbA1c Laboratory Test set.",
    },
    {
      population: "NUMEX",
      key: "numerator-exclusions-none",
      description: "No numerator exclusions.",
      valueSetOids: [],
      coverage: "COVERED",
      note: "WorkWell also defines no numerator exclusions — consistent with the official measure.",
    },
  ],
  valueSets: [
    { name: "Diabetes", oid: "2.16.840.1.113883.3.464.1003.103.12.1001", concept: "Diabetes" },
    { name: "HbA1c Laboratory Test", oid: "2.16.840.1.113883.3.464.1003.198.12.1013", concept: "HbA1c" },
    { name: "Office Visit", oid: "2.16.840.1.113883.3.464.1003.101.12.1001", concept: "Encounter" },
    { name: "Annual Wellness Visit", oid: "2.16.840.1.113883.3.526.3.1240", concept: "Encounter" },
    { name: "Preventive Care Services Established Office Visit, 18+", oid: "2.16.840.1.113883.3.464.1003.101.12.1025", concept: "Encounter" },
    { name: "Preventive Care Services Initial Office Visit, 18+", oid: "2.16.840.1.113883.3.464.1003.101.12.1023", concept: "Encounter" },
    { name: "Home Healthcare Services", oid: "2.16.840.1.113883.3.464.1003.101.12.1016", concept: "Encounter" },
    { name: "Telephone Visits", oid: "2.16.840.1.113883.3.464.1003.101.12.1080", concept: "Encounter" },
    { name: "Nursing Facility Visit", oid: "2.16.840.1.113883.3.464.1003.101.12.1012", concept: "LongTermCare" },
    { name: "Hospice Encounter", oid: "2.16.840.1.113883.3.464.1003.1003", concept: "Hospice" },
    { name: "Hospice care ambulatory", oid: "2.16.840.1.113762.1.4.1108.15", concept: "Hospice" },
    { name: "Hospice Diagnosis", oid: "2.16.840.1.113883.3.464.1003.1165", concept: "Hospice" },
    { name: "Frailty Diagnosis", oid: "2.16.840.1.113883.3.464.1003.113.12.1074", concept: "Frailty" },
    { name: "Frailty Device", oid: "2.16.840.1.113883.3.464.1003.118.12.1300", concept: "Frailty" },
    { name: "Frailty Encounter", oid: "2.16.840.1.113883.3.464.1003.101.12.1088", concept: "Frailty" },
    { name: "Frailty Symptom", oid: "2.16.840.1.113883.3.464.1003.113.12.1075", concept: "Frailty" },
    { name: "Advanced Illness", oid: "2.16.840.1.113883.3.464.1003.110.12.1082", concept: "AdvancedIllness" },
    { name: "Dementia Medications", oid: "2.16.840.1.113883.3.464.1003.196.12.1510", concept: "AdvancedIllness" },
    { name: "Palliative Care Diagnosis", oid: "2.16.840.1.113883.3.464.1003.1167", concept: "Palliative" },
    { name: "Palliative Care Encounter", oid: "2.16.840.1.113883.3.464.1003.101.12.1090", concept: "Palliative" },
    { name: "Palliative Care Intervention", oid: "2.16.840.1.113883.3.464.1003.198.12.1135", concept: "Palliative" },
  ],
  workwellValueSetCoverage: [
    { concept: "Diabetes", represented: true, workwellValueSet: "urn:workwell:vs:cms122-diabetes", note: "Local demo value set stands in for the official VSAC Diabetes set." },
    { concept: "HbA1c", represented: true, workwellValueSet: "urn:workwell:vs:cms122-hba1c", note: "Local demo value set stands in for the official HbA1c Laboratory Test set; no GMI." },
    { concept: "Encounter", represented: false, note: "WorkWell models no qualifying-visit value sets." },
    { concept: "LongTermCare", represented: false, note: "Not modeled." },
    { concept: "Hospice", represented: false, note: "Folded into one generic exclusion (urn:workwell:vs:cms122-excluded)." },
    { concept: "Frailty", represented: false, note: "Folded into one generic exclusion." },
    { concept: "AdvancedIllness", represented: false, note: "Folded into one generic exclusion." },
    { concept: "Palliative", represented: false, note: "Folded into one generic exclusion." },
  ],
};
```

- [ ] **Step 3: Create the lookup.** `backend-ts/src/standards/references/index.ts`:

```ts
import type { OfficialMeasureReference } from "../reference-types.ts";
import { CMS122V14 } from "./cms122v14.ts";

const REFERENCES: Record<string, OfficialMeasureReference> = {
  [CMS122V14.measureId]: CMS122V14,
};

/** The official reference for a WorkWell measure id, or undefined if none is vendored yet. */
export function referenceFor(measureId: string): OfficialMeasureReference | undefined {
  return REFERENCES[measureId];
}
```

- [ ] **Step 4: Write the reference-integrity test.** `backend-ts/src/standards/references/cms122v14.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CMS122V14 } from "./cms122v14.ts";
import { referenceFor } from "./index.ts";

test("CMS122v14 reference has identity + provenance", () => {
  assert.equal(CMS122V14.ecqmId, "CMS122v14");
  assert.equal(CMS122V14.version, "14.0.000");
  assert.equal(CMS122V14.measureId, "cms122");
  assert.ok(CMS122V14.provenance.sourceUrl.startsWith("https://ecqi.healthit.gov"));
});

test("CMS122v14 reference represents all five populations", () => {
  const pops = new Set(CMS122V14.criteria.map((c) => c.population));
  for (const p of ["IPP", "DENOM", "DENEX", "NUMER", "NUMEX"]) assert.ok(pops.has(p as never), `missing population ${p}`);
});

test("CMS122v14 reference: every criterion has a coverage + note; every value set has an oid + concept", () => {
  for (const c of CMS122V14.criteria) {
    assert.ok(["COVERED", "SIMPLIFIED", "OMITTED"].includes(c.coverage), `bad coverage on ${c.key}`);
    assert.ok(c.note.length > 0, `empty note on ${c.key}`);
  }
  for (const vs of CMS122V14.valueSets) {
    assert.match(vs.oid, /^2\.16\.840\./);
    assert.ok(vs.concept.length > 0);
  }
});

test("referenceFor resolves cms122 and is undefined for measures without a reference", () => {
  assert.equal(referenceFor("cms122")?.ecqmId, "CMS122v14");
  assert.equal(referenceFor("audiogram"), undefined);
});
```

- [ ] **Step 5: Run the test.**

Run: `cd backend-ts && node --import tsx --test src/standards/references/cms122v14.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit.**

```bash
git add backend-ts/src/standards/reference-types.ts backend-ts/src/standards/references/
git commit -m "feat(e14): vendored, sourced CMS122v14 official reference + lookup (#186)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The fidelity diff engine (`computeFidelity`)

**Files:**
- Create: `backend-ts/src/standards/measure-fidelity.ts`
- Create: `backend-ts/src/standards/measure-fidelity.test.ts`

- [ ] **Step 1: Write the failing test.** `backend-ts/src/standards/measure-fidelity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFidelity } from "./measure-fidelity.ts";
import { CMS122V14 } from "./references/cms122v14.ts";

test("computeFidelity: assembles a report with reconciling summary counts", () => {
  const r = computeFidelity(CMS122V14);
  assert.equal(r.ecqmId, "CMS122v14");
  assert.equal(r.measureId, "cms122");
  // counts reconcile with the criteria
  assert.equal(r.summary.covered + r.summary.simplified + r.summary.omitted, r.criteria.length);
  assert.equal(r.criteria.length, CMS122V14.criteria.length);
  // official value-set count is the reference's; workwell count is the distinct represented local sets
  assert.equal(r.summary.officialValueSetCount, CMS122V14.valueSets.length);
  assert.equal(r.summary.workwellValueSetCount, 2); // diabetes + hba1c
});

test("computeFidelity: classifies the headline criteria correctly", () => {
  const r = computeFidelity(CMS122V14);
  const byKey = Object.fromEntries(r.criteria.map((c) => [c.key, c.coverage]));
  assert.equal(byKey["age-18-75"], "OMITTED");
  assert.equal(byKey["qualifying-visit"], "OMITTED");
  assert.equal(byKey["hospice"], "OMITTED");
  assert.equal(byKey["hba1c-gmi-gt9-or-missing"], "SIMPLIFIED");
  assert.equal(byKey["numerator-exclusions-none"], "COVERED");
});

test("computeFidelity: value-set fidelity marks the exclusion concepts unrepresented", () => {
  const r = computeFidelity(CMS122V14);
  const byConcept = Object.fromEntries(r.valueSets.map((v) => [v.concept, v.workwellRepresented]));
  assert.equal(byConcept["Diabetes"], true);
  assert.equal(byConcept["HbA1c"], true);
  assert.equal(byConcept["Hospice"], false);
  assert.equal(byConcept["Frailty"], false);
  assert.equal(byConcept["Palliative"], false);
});

test("computeFidelity: a plain-English headline + disclaimer are present", () => {
  const r = computeFidelity(CMS122V14);
  assert.ok(r.summary.headline.length > 0);
  assert.match(r.disclaimer, /structural/i);
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd backend-ts && node --import tsx --test src/standards/measure-fidelity.test.ts`
Expected: FAIL — module `./measure-fidelity.ts` does not exist.

- [ ] **Step 3: Implement.** `backend-ts/src/standards/measure-fidelity.ts`:

```ts
/**
 * E14 (#186) standards fidelity diff — assemble a documented comparison of WorkWell's authored measure
 * against an official eCQM reference. PURE: no DB, no fs, no engine. STRUCTURAL/DEFINITIONAL — it does NOT
 * execute the official CQL and does NOT diff outcomes (that is PR-2). Never affects a compliance outcome.
 */
import type { Coverage, OfficialMeasureReference, Population } from "./reference-types.ts";

export interface CriterionFidelity {
  population: Population;
  key: string;
  description: string;
  coverage: Coverage;
  note: string;
  valueSetOids: string[];
}

export interface ValueSetFidelity {
  name: string;
  oid: string;
  concept: string;
  /** Does WorkWell's authored measure represent this official value-set concept? */
  workwellRepresented: boolean;
  workwellValueSet?: string;
  note: string;
}

export interface FidelityReport {
  measureId: string;
  ecqmId: string;
  title: string;
  version: string;
  steward: string;
  provenance: OfficialMeasureReference["provenance"];
  criteria: CriterionFidelity[];
  valueSets: ValueSetFidelity[];
  summary: {
    covered: number;
    simplified: number;
    omitted: number;
    officialValueSetCount: number;
    workwellValueSetCount: number;
    headline: string;
  };
  disclaimer: string;
}

const DISCLAIMER =
  "Structural/definitional fidelity diff: WorkWell's authored (simplified) measure vs the official eCQM " +
  "specification. It does not execute the official CQL or diff evaluated outcomes (deferred to E14 PR-2). " +
  "CQL Outcome Status remains the sole compliance authority (ADR-008).";

export function computeFidelity(ref: OfficialMeasureReference): FidelityReport {
  const criteria: CriterionFidelity[] = ref.criteria.map((c) => ({
    population: c.population,
    key: c.key,
    description: c.description,
    coverage: c.coverage,
    note: c.note,
    valueSetOids: c.valueSetOids,
  }));

  // Value-set fidelity: join each official value set to its concept's WorkWell coverage.
  const coverageByConcept = new Map(ref.workwellValueSetCoverage.map((w) => [w.concept, w]));
  const valueSets: ValueSetFidelity[] = ref.valueSets.map((vs) => {
    const w = coverageByConcept.get(vs.concept);
    return {
      name: vs.name,
      oid: vs.oid,
      concept: vs.concept,
      workwellRepresented: w?.represented ?? false,
      workwellValueSet: w?.workwellValueSet,
      note: w?.note ?? "No WorkWell value set represents this concept.",
    };
  });

  const covered = criteria.filter((c) => c.coverage === "COVERED").length;
  const simplified = criteria.filter((c) => c.coverage === "SIMPLIFIED").length;
  const omitted = criteria.filter((c) => c.coverage === "OMITTED").length;
  const workwellValueSetCount = new Set(
    ref.workwellValueSetCoverage.filter((w) => w.represented && w.workwellValueSet).map((w) => w.workwellValueSet!),
  ).size;

  const headline =
    `WorkWell's authored ${ref.measureId} covers ${covered} and simplifies ${simplified} of ${criteria.length} ` +
    `official ${ref.ecqmId} criteria, omitting ${omitted} (e.g. age/visit gating + denominator exclusions); ` +
    `it references ${workwellValueSetCount} local value sets vs ${ref.valueSets.length} official VSAC value sets.`;

  return {
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    title: ref.title,
    version: ref.version,
    steward: ref.steward,
    provenance: ref.provenance,
    criteria,
    valueSets,
    summary: { covered, simplified, omitted, officialValueSetCount: ref.valueSets.length, workwellValueSetCount, headline },
    disclaimer: DISCLAIMER,
  };
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `cd backend-ts && node --import tsx --test src/standards/measure-fidelity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add backend-ts/src/standards/measure-fidelity.ts backend-ts/src/standards/measure-fidelity.test.ts
git commit -m "feat(e14): computeFidelity — pure structural diff assembler + FidelityReport (#186)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The `GET /api/measures/:id/fidelity` endpoint

**Files:**
- Modify: `backend-ts/src/routes/measures.ts`

- [ ] **Step 1: Add the imports.** At the top of `backend-ts/src/routes/measures.ts`, add (next to the other `../standards` / module imports — match the existing import style):

```ts
import { referenceFor } from "../standards/references/index.ts";
import { computeFidelity } from "../standards/measure-fidelity.ts";
```

- [ ] **Step 2: Add the route branch.** In `handleMeasures(...)`, insert this branch IMMEDIATELY BEFORE the `detailId` catch-all (the `const detailId = pathname.match(/^\/api\/measures\/([^/]+)$/)...` block, ~line 435), so the more-specific `/fidelity` path is matched first:

```ts
  // Standards fidelity: a documented structural diff of WorkWell's authored measure vs the official
  // eCQM spec (E14 / #186). Read-only, descriptive — never affects an outcome (ADR-008). Returns
  // { available: false } for measures without a vendored official reference yet.
  const fidelityId = pathname.match(/^\/api\/measures\/([^/]+)\/fidelity$/)?.[1];
  if (fidelityId && req.method === "GET") {
    const r = await (await store(env)).getLatest(fidelityId);
    if (!r) return json({ error: "not_found", measureId: fidelityId }, 404);
    const ref = referenceFor(fidelityId);
    if (!ref) return json({ measureId: fidelityId, available: false });
    return json({ available: true, ...computeFidelity(ref) });
  }
```

(`store`, `json`, `env`, `pathname`, `req` are all already in scope in `handleMeasures` — confirm by reading the sibling `traceability` branch.)

- [ ] **Step 3: Add an endpoint test.** Check whether `backend-ts/src/routes/measures.test.ts` exists (`ls backend-ts/src/routes/measures.test.ts`). Read its harness (how it builds `env`, calls `handleMeasures`, and an `actor`). Append two tests mirroring that harness:

```ts
test("GET /api/measures/cms122/fidelity returns the fidelity report", async () => {
  const res = await handleMeasures(new Request("http://x/api/measures/cms122/fidelity"), env as never, actor);
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { available: boolean; ecqmId: string; summary: { omitted: number } };
  assert.equal(body.available, true);
  assert.equal(body.ecqmId, "CMS122v14");
  assert.ok(body.summary.omitted > 0);
});

test("GET /api/measures/audiogram/fidelity → available:false (no official reference yet)", async () => {
  const res = await handleMeasures(new Request("http://x/api/measures/audiogram/fidelity"), env as never, actor);
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { available: boolean };
  assert.equal(body.available, false);
});
```

If `measures.test.ts` does NOT exist, create `backend-ts/src/standards/fidelity-route.test.ts` instead, importing `handleMeasures` from `../routes/measures.ts` and building the same `env`/`actor` the way another route test in `backend-ts/src/routes/*.test.ts` does (read one — e.g. `segments.test.ts` — for the in-memory `env` + `actor` setup, including any required seeding). Adapt so `getLatest("cms122")`/`getLatest("audiogram")` find the seeded measures (the measure store must be seeded — mirror whatever an existing measures-route test does; if seeding the full measure catalog is heavy, the existing `measures.test.ts` harness is the right model to copy).

- [ ] **Step 4: Run the route test + typecheck.**

Run: `cd backend-ts && node --import tsx --test src/routes/measures.test.ts` (or the new `src/standards/fidelity-route.test.ts`) `&& corepack pnpm@10 typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit.**

```bash
git add backend-ts/src/routes/measures.ts backend-ts/src/routes/measures.test.ts backend-ts/src/standards/fidelity-route.test.ts 2>/dev/null; git commit -m "feat(e14): GET /api/measures/:id/fidelity — official-spec fidelity report (#186)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Jurisdiction measure metadata

**Files:**
- Modify: `backend-ts/src/engine/cql/measure-registry.ts`
- Modify: `backend-ts/src/measure/measure-read-models.ts`

- [ ] **Step 1: Add the field to `MeasureMeta`.** In `backend-ts/src/engine/cql/measure-registry.ts`, add to the `MeasureMeta` interface (after `valueSets?`):

```ts
  /** Regulatory jurisdiction this measure's spec belongs to (E14 / #186). Defaults to "US" when absent. */
  jurisdiction?: string;
```

(Do NOT set it on every `MEASURES` entry — the default is applied at read time. This keeps the registry diff to one line.)

- [ ] **Step 2: Surface it on the read model.** In `backend-ts/src/measure/measure-read-models.ts`:
  - Read `toMeasureDetail(...)` + the `MeasureDetail` interface first. Add a field to `MeasureDetail`:
    ```ts
    jurisdiction: string;
    ```
  - In `toMeasureDetail(...)`, set `jurisdiction`. Source it from the registry by measure id with a `"US"` default. At the top of the file add the import:
    ```ts
    import { MEASURES } from "../engine/cql/measure-registry.ts";
    ```
    and in the returned object add (use the measure's registry id — the read model already has the measure record `r`; use whatever id field it exposes, e.g. `r.measureId` or the slug used elsewhere in the function — match how the function already keys by id):
    ```ts
    jurisdiction: MEASURES[<measureIdInScope>]?.jurisdiction ?? "US",
    ```
  Read the function body to find the in-scope measure id variable (the same one other fields use); if the read model is not keyed by the registry slug, default to `"US"` unconditionally (`jurisdiction: "US",`) and note that per-measure jurisdiction wiring is deferred — the field + default is the PR-1 deliverable.

- [ ] **Step 3: Add/extend a read-model test.** Find the read-models test (`backend-ts/src/measure/measure-read-models.test.ts` if present). Add an assertion that `toMeasureDetail(...)` output has `jurisdiction === "US"`. If no such test file exists, add a minimal one constructing a measure record the way the file's other consumers do (read an existing caller/test for the record shape) and asserting the default. Keep it small.

- [ ] **Step 4: Run + typecheck.**

Run: `cd backend-ts && node --import tsx --test src/measure/measure-read-models.test.ts 2>/dev/null; corepack pnpm@10 typecheck`
Expected: typecheck clean; the read-model test passes (or, if you added a new test, it passes).

- [ ] **Step 5: Commit.**

```bash
git add backend-ts/src/engine/cql/measure-registry.ts backend-ts/src/measure/measure-read-models.ts backend-ts/src/measure/measure-read-models.test.ts 2>/dev/null; git commit -m "feat(e14): jurisdiction measure metadata (default US) on MeasureMeta + read model (#186)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Country-aware design memo + docs + full verification + PR

**Files:** `docs/standards/country-aware-regulatory-sourcing.md`, `docs/STANDARDS_CONFORMANCE.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`.

- [ ] **Step 1: Country-aware design memo.** Create `docs/standards/country-aware-regulatory-sourcing.md` — a design-first memo (no code beyond the PR-1 `jurisdiction` field). Cover, proportionally:
  - **Today (PR-1):** `jurisdiction` is measure metadata (default `US`), surfaced on the measure detail.
  - **The model:** a `RegulatorySource` concept — for US eCQMs the source is eCQI/CMS (with the `OfficialMeasureReference` PR-1 introduced); for US OSHA safety measures the source is the CFR citation (`policyRef`); non-US analogues are named-but-unbuilt (e.g. a jurisdiction's national immunization schedule or occupational-health regulator).
  - **Country switch:** how selecting a jurisdiction would pick an alternate official reference + (future) an alternate rule set; the measure stays one logical measure with per-jurisdiction bindings.
  - **"Latest regulatory updates by country" (aspirational):** a future watcher that periodically diffs a measure against the newest published official version (e.g. CMS122v14 → v15) using the `OfficialMeasureReference.version` + provenance, surfacing a fidelity-drift alert. Design-only.
  - State clearly this is design-first/aspirational per the issue Notes; PR-1 ships only the metadata field + this memo.

- [ ] **Step 2: `docs/STANDARDS_CONFORMANCE.md`.** Read it, then add a row/section for **E14 — standards fidelity**: WorkWell authored measure vs official eCQM spec, a structural fidelity diff (`GET /api/measures/:id/fidelity`), sourced reference (CMS122v14), descriptive only; official-CQL execution + outcome diff deferred to PR-2 behind the E3.2 `ValueSetResolver` seam. Match the file's existing table/format.

- [ ] **Step 3: ADR in `docs/DECISIONS.md`.** Read the file, use the next ADR number (verify — expected **ADR-018**). Record: E14 fidelity is **structural/definitional-first** (a sourced official reference + a documented diff), with official-CQL **execution** (outcome diff) deferred (research-grade: QDM→FHIR, ~20 VSAC value sets, shared exclusion libraries, QI-Core bundles) behind the E3.2 seam; `jurisdiction` modeled as measure metadata; the report is descriptive — CQL `Outcome Status` stays authoritative (ADR-008); no schema, no new deps. Keep it proportional.

- [ ] **Step 4: `docs/JOURNAL.md`.** Add a new top entry dated 2026-06-26 (match house style) summarizing E14 PR-1: the `standards/` module (sourced CMS122v14 reference + `computeFidelity` + `GET /api/measures/:id/fidelity`), the jurisdiction metadata + country-aware memo, the structural-first scope decision (ADR-018) with execution deferred to PR-2; no schema/new deps; backend suite green.

- [ ] **Step 5: Commit docs.**

```bash
git add docs/standards/country-aware-regulatory-sourcing.md docs/STANDARDS_CONFORMANCE.md docs/DECISIONS.md docs/JOURNAL.md
git commit -m "docs(e14): country-aware memo + STANDARDS_CONFORMANCE/ADR-018/JOURNAL for PR-1 (#186)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Full verification.**

Run (from `backend-ts/`): `corepack pnpm@10 typecheck && corepack pnpm@10 test`
Expected: typecheck clean; all tests pass (the new `standards/` tests + the route + read-model tests included; the one Pg-ceiling contract test may self-skip without a local postgres — expected). If anything this branch introduced fails, STOP and fix before proceeding.

- [ ] **Step 7: Whole-branch code review.** (Coordinator runs `superpowers:code-reviewer` over `git diff main...feat/e14-standards-fidelity`. Address findings.)

- [ ] **Step 8: Push + PR (coordinator; do NOT merge — the maintainer reviews + merges).**

```bash
git push -u origin feat/e14-standards-fidelity
gh pr create --title "E14 PR-1 — standards fidelity diff (CMS122v14) + jurisdiction metadata (#186)" --body "<summary; structural fidelity diff vs official CMS122v14 (sourced); GET /api/measures/:id/fidelity; jurisdiction metadata + country memo; official-CQL execution deferred to PR-2; descriptive only (ADR-008); no schema/new deps; 🤖 Generated with Claude Code footer>"
```

Expected: CI green.

---

## Self-Review (completed by plan author)

**Spec coverage:** design §5.1 (vendored reference) → Task 1. §5.3 (fidelity engine) → Task 2. §5.5 (endpoint) → Task 3. §5.4 (jurisdiction metadata) → Task 4. §5.6 (country memo) → Task 5. §2 scope decision (structural-first; execution deferred) → Task 5 ADR + the `disclaimer` in Task 2. §8 testing → embedded per task. Acceptance (a) documented diff → Tasks 1–3; (b) jurisdiction + memo → Tasks 4–5. ✅  (Design §5.2 `authored-measure.ts` was intentionally folded into the curated reference for PR-1 — the coverage is curated/sourced, so a separate runtime CQL scan is YAGNI and would add `node:fs` on the request path; `computeFidelity` is a pure function over the reference. Noted as a deliberate simplification.)

**Placeholder scan:** All code shown in full; the CMS122v14 reference data is complete and transcribed from the cited sources; the two lookups requiring file inspection (the `measures.test.ts` harness in Task 3, the read-model id variable in Task 4) give explicit fallbacks. ADR number is a verify-then-use (expected ADR-018). No TBD/TODO. ✅

**Type consistency:** `OfficialMeasureReference`/`OfficialCriterion`/`OfficialValueSet`/`WorkwellValueSetCoverage`/`Coverage`/`Population` defined once (Task 1) and consumed by `computeFidelity` (Task 2) + the reference (Task 1). `FidelityReport`/`CriterionFidelity`/`ValueSetFidelity` defined in Task 2 and consumed by the route (Task 3). `referenceFor(measureId)` + `computeFidelity(ref)` signatures match across Tasks 1–3. `jurisdiction` field name consistent across Task 4. ✅
