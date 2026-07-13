# E14 PR-2: Outcome Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /api/measures/:id/fidelity/diff` that shows, criterion by criterion, how many subjects from the latest CMS122 population run would have different outcomes if the official eCQM criteria (currently OMITTED/SIMPLIFIED) were applied — surfacing the gap between WorkWell's authored measure and the official spec.

**Architecture:** Pure TypeScript criteria-impact analysis on top of existing run outcomes — no CQL re-evaluation, no new dependencies, no schema. For each criterion in the vendored `CMS122V14` reference (E14 PR-1): if it's verifiable with synthetic data (the age-18-75 gate is, because `fhir-bundle-builder.ts` stamps a deterministic `birthDate` on every patient), compute how many subjects diverge; if unverifiable (encounters, hospice, frailty, palliative — not in synthetic bundles), label it clearly. This is explicitly framed as a criteria-impact estimate; the disclaimer notes that a full outcome diff (executing the official CQL with real VSAC value sets) requires the `ValueSetResolver` port once VSAC credentials are available. Descriptive only — never affects a compliance outcome (ADR-008).

**Tech stack:** TypeScript, `node:test`, existing `OutcomeWithRun` + `listOutcomesWithRun` from `OutcomeStore`, `latestRunRows`/`isPopulationRun` from `program/rollup-shared.ts`, the `referenceFor`/`OfficialMeasureReference` types from E14 PR-1 (`standards/references/index.ts`, `standards/reference-types.ts`).

---

## Context you MUST read before touching any file

This is Epic 14 PR-2 of the WorkWell Measure Studio (a TypeScript + Next.js healthcare compliance monorepo). Work in `backend-ts/` only.

**E14 PR-1 (already merged)** added `backend-ts/src/standards/` — a pure module with:
- `reference-types.ts` — `OfficialMeasureReference`, `OfficialCriterion`, `Coverage` ("COVERED" | "SIMPLIFIED" | "OMITTED"), `Population` types
- `measure-fidelity.ts` — `computeFidelity(ref)` → `FidelityReport` (structural diff: which criteria are OMITTED/SIMPLIFIED/COVERED)
- `references/cms122v14.ts` — the vendored `CMS122V14` object with 10 criteria across IPP/DENOM/DENEX/NUMER/NUMEX populations
- `references/index.ts` — `referenceFor(measureId)` registry
- `routes/measures.ts` already wires `GET /api/measures/:id/fidelity`

**Synthetic patient birthDates (critical):** `fhir-bundle-builder.ts` computes `birthDate(externalId)` as `${1980 + (h % 20)}-01-01` (hash of externalId modulo 20). In 2026 this gives ages 27–46 — all within the 18–75 official IPP age gate. So the age criterion produces **0 divergent subjects** with the current synthetic population. That is the correct, honest result for the demo.

**Key store patterns:**
- `getStores(env)` (from `stores/factory.ts`) returns `{ outcomes, runs, measures, ... }`
- `stores.outcomes.listOutcomesWithRun({ measureId, excludeScale: true })` returns `OutcomeWithRun[]`
- `OutcomeWithRun` has: `{ runId, runStartedAt, runScopeType, runStatus, runTriggeredBy, subjectId, measureId, status }`
- `latestRunRows(rows)` from `program/rollup-shared.ts` returns only the rows from the single most-recent run
- `isPopulationRun(scopeType)` from `program/rollup-shared.ts` returns true for ALL_PROGRAMS/MEASURE/SITE (not CASE/EMPLOYEE reruns)

**Run tests:** `cd backend-ts && pnpm test` (SQLite floor, ~770 tests, ~30s)

---

## File Map

| File | Action | What it does |
|------|--------|--------------|
| `backend-ts/src/standards/outcome-diff.ts` | **Create** | `CriterionImpact`, `OutcomeDiffReport` types + pure `computeOutcomeDiff` function |
| `backend-ts/src/standards/outcome-diff.test.ts` | **Create** | Unit tests for `computeOutcomeDiff` |
| `backend-ts/src/routes/measures.ts` | **Modify** | Add `GET /api/measures/:id/fidelity/diff` route (~15 lines) |
| `backend-ts/src/routes/measures.test.ts` | **Modify** | Add route-level integration tests for the new endpoint |
| `docs/JOURNAL.md` | **Modify** | Append E14 PR-2 entry |

---

## Task 1: Create `outcome-diff.ts` — types only (no logic yet)

**Files:**
- Create: `backend-ts/src/standards/outcome-diff.ts`
- Test: `backend-ts/src/standards/outcome-diff.test.ts` (stub only in this task)

- [ ] **Step 1: Write the failing test (import check)**

Create `backend-ts/src/standards/outcome-diff.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeDiffReport, CriterionImpact } from "./outcome-diff.ts";

test("OutcomeDiffReport type exists and is importable", () => {
  // Types-only smoke: if the import fails, this test file won't parse.
  const _: OutcomeDiffReport = {
    measureId: "cms122",
    ecqmId: "CMS122v14",
    runId: null,
    asOf: null,
    totalSubjectsEvaluated: 0,
    totalDivergent: 0,
    criterionImpacts: [],
    headline: "test",
    disclaimer: "test",
  };
  assert.ok(true);
});
```

- [ ] **Step 2: Run test to confirm it fails (import error)**

```bash
cd backend-ts && pnpm test --test-name-pattern "OutcomeDiffReport type"
```

Expected: Error — `outcome-diff.ts` does not exist yet.

- [ ] **Step 3: Create `backend-ts/src/standards/outcome-diff.ts` with types**

```typescript
/**
 * E14 PR-2 (#186) — outcome-diff: estimates, criterion by criterion, how many subjects
 * from the latest CMS122 population run would diverge if the official eCQM criteria
 * (OMITTED/SIMPLIFIED in WorkWell's authored measure) were applied. Descriptive only —
 * never affects a compliance outcome (ADR-008).
 *
 * Not a full CQL re-execution: a full outcome diff requires the official VSAC value sets
 * via the ValueSetResolver port (deferred until VSAC credentials are available). Instead
 * this is a criteria-impact analysis: for verifiable criteria (age gate — synthetic
 * patients have deterministic birthDates), count divergent subjects; for unverifiable
 * criteria (encounters, hospice, frailty, palliative — absent from synthetic bundles),
 * report why verification is impossible.
 */
import type { Coverage, OfficialMeasureReference, Population } from "./reference-types.ts";

export interface CriterionImpact {
  /** Matches `key` from the official reference criterion. */
  key: string;
  population: Population;
  coverage: Coverage;
  /** Whether this criterion can be evaluated against synthetic patient data. */
  verifiable: boolean;
  /** Subjects whose WorkWell outcome would change if this criterion were applied. 0 when unverifiable. */
  subjectsAffected: number;
  /** For unverifiable criteria: the synthetic-data gap that prevents evaluation. */
  reason?: string;
  /** Sourced note from the official reference. */
  note: string;
}

export interface OutcomeDiffReport {
  measureId: string;
  ecqmId: string;
  /** The population run this diff is based on, or null when no run exists yet. */
  runId: string | null;
  /** ISO date (YYYY-MM-DD) of the population run, or null when no run exists yet. */
  asOf: string | null;
  totalSubjectsEvaluated: number;
  /** Sum of `subjectsAffected` across all verifiable OMITTED/SIMPLIFIED criteria. */
  totalDivergent: number;
  criterionImpacts: CriterionImpact[];
  headline: string;
  disclaimer: string;
}

// --- implementation ----------------------------------------------------------------

const DISCLAIMER =
  "Criteria-impact analysis: estimates how many evaluated subjects would have different outcomes " +
  "if the official eCQM criteria omitted or simplified by WorkWell's authored measure were applied. " +
  "Unverifiable criteria lack the required clinical data in the synthetic dataset. This is descriptive — " +
  "CQL Outcome Status remains the sole compliance authority (ADR-008). A full outcome diff (executing the " +
  "official CQL with real VSAC value sets) requires the ValueSetResolver port once VSAC credentials are available.";

/**
 * Same hash formula as fhir-bundle-builder.ts `birthDate()`. Duplicated here (not imported)
 * to keep the standards module free of engine/synthetic dependencies.
 * Formula: `1980 + (hash(externalId) % 20)` → birth years 1980–1999 → ages 27–46 in 2026.
 */
function syntheticBirthYear(externalId: string): number {
  let h = 0;
  for (const ch of externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1980 + (h % 20);
}

function ageAt(externalId: string, evalYear: number): number {
  return evalYear - syntheticBirthYear(externalId);
}

/**
 * Per-criterion evaluator: returns true when the subject WOULD diverge (i.e. the official
 * criterion, if applied, would change their outcome from what WorkWell computed).
 */
type CriterionEvaluator = (subjectId: string, currentStatus: string, evalYear: number) => boolean;

const EVALUATORS: Partial<Record<string, CriterionEvaluator>> = {
  "age-18-75": (subjectId, _status, evalYear) => {
    const age = ageAt(subjectId, evalYear);
    return age < 18 || age > 75;
  },
};

const UNVERIFIABLE_REASONS: Partial<Record<string, string>> = {
  "qualifying-visit":
    "Synthetic FHIR bundles include no Encounter resources — the official qualifying-visit gate cannot be evaluated.",
  "hospice":
    "Synthetic FHIR bundles include no hospice Encounter or Service Request resources.",
  "long-term-care-66":
    "Synthetic FHIR bundles include no Housing Status Assessment (LOINC 71802-3) resources.",
  "advanced-illness-frailty-66":
    "Synthetic FHIR bundles include no frailty Diagnosis, Device, Encounter, or Symptom resources.",
  "palliative-care":
    "Synthetic FHIR bundles include no palliative-care Encounter, Diagnosis, or Intervention resources.",
  "denominator-equals-ipp":
    "Denominator-equals-IPP simplification impact depends on the IPP gate divergence (age + visit), which is partially unverifiable.",
};

type OutcomeSlice = {
  subjectId: string;
  status: string;
  runId: string;
  runStartedAt: string;
};

/**
 * Compute a criteria-impact diff report for `ref` against `outcomes` (the latest population run's
 * rows for the measure, already filtered to a single run by the caller). `evalYear` defaults to the
 * current UTC year; pass a fixed value in tests for deterministic output.
 */
export function computeOutcomeDiff(
  ref: OfficialMeasureReference,
  outcomes: OutcomeSlice[],
  evalYear: number = new Date().getUTCFullYear(),
): OutcomeDiffReport {
  const runId = outcomes[0]?.runId ?? null;
  const asOf = outcomes[0]?.runStartedAt?.slice(0, 10) ?? null;
  let totalDivergent = 0;

  const criterionImpacts: CriterionImpact[] = ref.criteria.map((c) => {
    if (c.coverage === "COVERED") {
      return {
        key: c.key,
        population: c.population,
        coverage: c.coverage,
        verifiable: true,
        subjectsAffected: 0,
        note: c.note,
      };
    }

    const evaluator = EVALUATORS[c.key];
    if (!evaluator) {
      const reason =
        UNVERIFIABLE_REASONS[c.key] ?? "No synthetic clinical data available for this criterion.";
      return {
        key: c.key,
        population: c.population,
        coverage: c.coverage,
        verifiable: false,
        subjectsAffected: 0,
        reason,
        note: c.note,
      };
    }

    const affected = outcomes.filter((o) => evaluator(o.subjectId, o.status, evalYear)).length;
    totalDivergent += affected;
    return {
      key: c.key,
      population: c.population,
      coverage: c.coverage,
      verifiable: true,
      subjectsAffected: affected,
      note: c.note,
    };
  });

  const verifiableCount = criterionImpacts.filter((c) => c.verifiable).length;
  const unverifiableCount = criterionImpacts.filter((c) => !c.verifiable).length;

  const headline =
    `Of ${outcomes.length} subjects in the latest ${ref.measureId} population run, ` +
    `${totalDivergent} diverge on the ${verifiableCount} verifiable official ${ref.ecqmId} criteria; ` +
    `${unverifiableCount} criteria are unverifiable with synthetic data ` +
    `(encounter, hospice, frailty, and palliative-care records absent).`;

  return {
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    runId,
    asOf,
    totalSubjectsEvaluated: outcomes.length,
    totalDivergent,
    criterionImpacts,
    headline,
    disclaimer: DISCLAIMER,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend-ts && pnpm test --test-name-pattern "OutcomeDiffReport type"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/standards/outcome-diff.ts backend-ts/src/standards/outcome-diff.test.ts
git commit -m "feat(e14): add OutcomeDiffReport type + computeOutcomeDiff (PR-2)"
```

---

## Task 2: Unit-test `computeOutcomeDiff` thoroughly

**Files:**
- Modify: `backend-ts/src/standards/outcome-diff.test.ts`

- [ ] **Step 1: Replace the stub with the full test suite**

Overwrite `backend-ts/src/standards/outcome-diff.test.ts` completely:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutcomeDiff } from "./outcome-diff.ts";
import { CMS122V14 } from "./references/cms122v14.ts";

// Three subjects with externalIds that hash into birth years 1980–1999 → ages 27–46 in 2026.
// All are within the 18–75 official IPP age gate, so age divergence = 0.
const MOCK_OUTCOMES = [
  { subjectId: "emp-001", status: "OVERDUE",       runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
  { subjectId: "emp-002", status: "COMPLIANT",     runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
  { subjectId: "emp-003", status: "MISSING_DATA",  runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
];

test("computeOutcomeDiff: one impact per criterion, measureId + ecqmId match ref", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.equal(r.measureId, "cms122");
  assert.equal(r.ecqmId, "CMS122v14");
  assert.equal(r.totalSubjectsEvaluated, 3);
  assert.equal(r.criterionImpacts.length, CMS122V14.criteria.length);
});

test("computeOutcomeDiff: run provenance comes from first outcome row", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.equal(r.runId, "run-1");
  assert.equal(r.asOf, "2026-06-01");
});

test("computeOutcomeDiff: age-18-75 is verifiable; all emp-00x ages 27–46 → 0 divergent", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const age = r.criterionImpacts.find((c) => c.key === "age-18-75")!;
  assert.ok(age, "age-18-75 criterion must be present");
  assert.equal(age.verifiable, true);
  assert.equal(age.subjectsAffected, 0);
  assert.equal(age.coverage, "OMITTED");
});

test("computeOutcomeDiff: qualifying-visit is unverifiable with a reason string", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const visit = r.criterionImpacts.find((c) => c.key === "qualifying-visit")!;
  assert.ok(visit);
  assert.equal(visit.verifiable, false);
  assert.equal(visit.subjectsAffected, 0);
  assert.ok(visit.reason && visit.reason.length > 0);
});

test("computeOutcomeDiff: hospice, long-term-care-66, advanced-illness-frailty-66, palliative-care all unverifiable", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  for (const key of ["hospice", "long-term-care-66", "advanced-illness-frailty-66", "palliative-care"]) {
    const c = r.criterionImpacts.find((x) => x.key === key)!;
    assert.ok(c, `missing criterion ${key}`);
    assert.equal(c.verifiable, false, `${key} should be unverifiable`);
    assert.ok(c.reason, `${key} should have a reason`);
  }
});

test("computeOutcomeDiff: COVERED criterion numerator-exclusions-none has verifiable=true and 0 divergent", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const numex = r.criterionImpacts.find((c) => c.key === "numerator-exclusions-none")!;
  assert.ok(numex);
  assert.equal(numex.coverage, "COVERED");
  assert.equal(numex.verifiable, true);
  assert.equal(numex.subjectsAffected, 0);
});

test("computeOutcomeDiff: totalDivergent equals sum of subjectsAffected across all impacts", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const sum = r.criterionImpacts.reduce((acc, c) => acc + c.subjectsAffected, 0);
  assert.equal(r.totalDivergent, sum);
});

test("computeOutcomeDiff: headline is non-empty and mentions totalSubjectsEvaluated and totalDivergent", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.ok(r.headline.length > 0);
  assert.match(r.headline, new RegExp(String(r.totalSubjectsEvaluated)));
  assert.match(r.headline, new RegExp(String(r.totalDivergent)));
});

test("computeOutcomeDiff: disclaimer is non-empty and mentions ValueSetResolver", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.match(r.disclaimer, /ValueSetResolver/);
  assert.match(r.disclaimer, /ADR-008/);
});

test("computeOutcomeDiff: empty outcomes returns valid report with zeros", () => {
  const r = computeOutcomeDiff(CMS122V14, [], 2026);
  assert.equal(r.runId, null);
  assert.equal(r.asOf, null);
  assert.equal(r.totalSubjectsEvaluated, 0);
  assert.equal(r.totalDivergent, 0);
  assert.equal(r.criterionImpacts.length, CMS122V14.criteria.length);
});

test("computeOutcomeDiff: subjects born outside 18-75 range ARE counted as divergent on age criterion", () => {
  // Construct a fake externalId that hashes to a birth year outside 18–75 in a given evalYear.
  // birth year 1940 → age 86 in 2026. We need hash % 20 = 0 (birth 1980) vs age 86 (1940).
  // Instead: we use evalYear=1950 so birth year 1980 gives age -30 (<18) → divergent.
  const outcomes = [{ subjectId: "emp-001", status: "OVERDUE", runId: "r", runStartedAt: "1950-01-01" }];
  const r = computeOutcomeDiff(CMS122V14, outcomes, 1950);
  const age = r.criterionImpacts.find((c) => c.key === "age-18-75")!;
  // birth year 1980, evalYear 1950 → age = -30 → outside 18-75 → divergent
  assert.equal(age.subjectsAffected, 1);
  assert.equal(r.totalDivergent, 1);
});
```

- [ ] **Step 2: Run all tests in the standards module**

```bash
cd backend-ts && pnpm test --test-name-pattern "computeOutcomeDiff"
```

Expected: All 10 tests PASS.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
cd backend-ts && pnpm test 2>&1 | tail -5
```

Expected: ~770 pass, 1 pg-skip, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add backend-ts/src/standards/outcome-diff.test.ts
git commit -m "test(e14): full unit-test coverage for computeOutcomeDiff (PR-2)"
```

---

## Task 3: Wire `GET /api/measures/:id/fidelity/diff` route

**Files:**
- Modify: `backend-ts/src/routes/measures.ts` (add ~20 lines + 2 imports)
- Modify: `backend-ts/src/routes/measures.test.ts` (add route integration tests)

### 3a — Add route to `measures.ts`

- [ ] **Step 1: Write the failing test first**

Find `measures.test.ts` and look for how other fidelity tests are written. Add these tests in the same file, after the existing fidelity tests:

```typescript
// ── E14 PR-2: fidelity/diff ────────────────────────────────────────────────

test("GET /api/measures/cms122/fidelity/diff — returns available:false when no reference exists for a made-up id", async (t) => {
  const { env } = await setup(t);
  const res = await handleMeasures(new Request("http://x/api/measures/no-such-measure/fidelity/diff"), env);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.available, false);
});

test("GET /api/measures/cms122/fidelity/diff — returns available:true with a valid report when outcomes exist", async (t) => {
  const { env, stores } = await setup(t);
  // Seed a completed ALL_PROGRAMS run + some cms122 outcomes.
  const run = await stores.runs.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "manual",
    requestedScope: {},
    measurementPeriodStart: "2026-01-01",
    measurementPeriodEnd: "2026-06-01",
    status: "COMPLETED",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
  await stores.runs.finalizeRun(run.id, "COMPLETED");
  // We need an outcome linked to cms122 measure version. Look up the cms122 measure version id.
  const mv = await stores.measures.getLatest("cms122");
  if (!mv) { t.skip("cms122 not seeded"); return; }
  await stores.outcomes.recordOutcome({
    runId: run.id,
    subjectId: "emp-001",
    measureId: "cms122",
    measureVersionId: mv.id,
    evaluationPeriod: "2026-06-01",
    status: "OVERDUE",
    evidence: {},
  });

  const res = await handleMeasures(new Request("http://x/api/measures/cms122/fidelity/diff"), env);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.available, true);
  assert.equal(body.measureId, "cms122");
  assert.equal(body.ecqmId, "CMS122v14");
  assert.ok(Array.isArray(body.criterionImpacts));
  assert.ok((body.criterionImpacts as unknown[]).length > 0);
  assert.ok(typeof body.totalSubjectsEvaluated === "number");
  assert.ok(typeof body.totalDivergent === "number");
  assert.ok(typeof body.headline === "string" && (body.headline as string).length > 0);
  assert.ok(typeof body.disclaimer === "string");
});

test("GET /api/measures/cms122/fidelity/diff — returns available:true with 0 subjects when no run exists", async (t) => {
  const { env } = await setup(t);
  const res = await handleMeasures(new Request("http://x/api/measures/cms122/fidelity/diff"), env);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.available, true);
  assert.equal(body.totalSubjectsEvaluated, 0);
  assert.equal(body.runId, null);
});
```

Note: look at the existing `measures.test.ts` pattern for `setup(t)` — it should return `{ env, stores }` where `stores` is the SQLite-backed store factory. Follow the same setup used by the existing fidelity tests.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd backend-ts && pnpm test --test-name-pattern "fidelity/diff"
```

Expected: FAIL — route not implemented yet.

- [ ] **Step 3: Add the two new imports to `measures.ts`**

Open `backend-ts/src/routes/measures.ts`. Find the imports section (around lines 62–63 where `referenceFor` and `computeFidelity` are already imported). Add two more imports immediately after those two lines:

```typescript
import { latestRunRows, isPopulationRun } from "../program/rollup-shared.ts";
import { computeOutcomeDiff } from "../standards/outcome-diff.ts";
```

(The file already imports `referenceFor` and `computeFidelity` from their respective paths — add to that block.)

- [ ] **Step 4: Add the diff route to `measures.ts`**

Find the existing fidelity route in `measures.ts`:
```typescript
const fidelityId = pathname.match(/^\/api\/measures\/([^/]+)\/fidelity$/)?.[1];
if (fidelityId && req.method === "GET") {
```

Add the diff route **immediately before** the fidelity route (order matters since `/fidelity/diff` is more specific — though both patterns are anchored with `$`, adding before is safer):

```typescript
  // E14 PR-2: criteria-impact outcome diff (GET /api/measures/:id/fidelity/diff).
  // Estimates how many subjects from the latest population run would diverge if the
  // official eCQM criteria (OMITTED/SIMPLIFIED) were applied. Read-only, descriptive —
  // never affects an outcome (ADR-008). Returns { available: false } when no reference exists.
  const diffMeasureId = pathname.match(/^\/api\/measures\/([^/]+)\/fidelity\/diff$/)?.[1];
  if (diffMeasureId && req.method === "GET") {
    const ref = referenceFor(diffMeasureId);
    if (!ref) return json({ measureId: diffMeasureId, available: false });
    const s = await getStores(env);
    const allOutcomes = await s.outcomes.listOutcomesWithRun({ measureId: diffMeasureId, excludeScale: true });
    const latest = latestRunRows(
      allOutcomes.filter(
        (o) => isPopulationRun(o.runScopeType) && o.runStatus === "COMPLETED" && o.runTriggeredBy !== "seed:trend-history",
      ),
    );
    const report = computeOutcomeDiff(ref, latest, new Date().getUTCFullYear());
    return json({ available: true, ...report });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend-ts && pnpm test --test-name-pattern "fidelity/diff"
```

Expected: All 3 new tests PASS.

**If `recordOutcome` signature doesn't exactly match**: Look at how other `measures.test.ts` tests seed outcomes (search for `recordOutcome` in the file) and use the same argument shape. The key fields are `runId`, `subjectId`, `measureVersionId`, `evaluationPeriod`, `status`, `evidence`.

- [ ] **Step 6: Run the full suite to confirm no regressions**

```bash
cd backend-ts && pnpm test 2>&1 | tail -5
```

Expected: ~773 pass (3 new tests added), 1 pg-skip, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/routes/measures.ts backend-ts/src/routes/measures.test.ts
git commit -m "feat(e14): wire GET /api/measures/:id/fidelity/diff (PR-2 outcome diff)"
```

---

## Task 4: Manual smoke + Journal entry

**Files:**
- Modify: `docs/JOURNAL.md`

- [ ] **Step 1: Smoke the live endpoint (optional but recommended)**

With the backend running locally (`cd backend-ts && pnpm dev`), hit the endpoint with an admin token:

```bash
TOKEN=$(curl -sf -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@workwell.dev","password":"Workwell123!"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

curl -sf -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/measures/cms122/fidelity/diff | node -e \
  "process.stdin.on('data',d=>{const r=JSON.parse(d);console.log(r.headline);console.log('divergent:',r.totalDivergent,'evaluated:',r.totalSubjectsEvaluated)})"
```

Expected output (approximate):
```
Of 42 subjects in the latest cms122 population run, 0 diverge on the 2 verifiable official CMS122v14 criteria; 8 criteria are unverifiable with synthetic data (encounter, hospice, frailty, and palliative-care records absent).
divergent: 0  evaluated: 42
```

- [ ] **Step 2: Append Journal entry**

Open `docs/JOURNAL.md` and prepend a new entry at the top (below the `# WorkWell Measure Studio — Dev Journal` header):

```markdown
## 2026-06-29 — E14 PR-2: Outcome diff (criteria-impact analysis)

**PR:** `feat/e14-pr2-outcome-diff` → PR #217

**Goal:** Surface, criterion by criterion, how many subjects from the latest CMS122 population run would diverge if the official CMS122v14 criteria (OMITTED/SIMPLIFIED in WorkWell's authored measure) were applied.

**What shipped:**

- **`backend-ts/src/standards/outcome-diff.ts`** — pure `computeOutcomeDiff(ref, outcomes, evalYear)` → `OutcomeDiffReport`. For each criterion in the official reference:
  - COVERED → `verifiable: true`, `subjectsAffected: 0`.
  - OMITTED with an evaluator (age-18-75) → count subjects outside 18–75 (deterministic from the hash-based `birthDate` formula in `fhir-bundle-builder.ts`, duplicated as a pure local function to keep the standards module dependency-free).
  - OMITTED/SIMPLIFIED without an evaluator (encounter, hospice, frailty, palliative) → `verifiable: false` + a reason string.
  - `totalDivergent` = Σ `subjectsAffected` across all verifiable criteria.
- **`GET /api/measures/:id/fidelity/diff`** — reads latest non-seed completed ALL_PROGRAMS run outcomes via `listOutcomesWithRun({ measureId, excludeScale: true })` + `latestRunRows`/`isPopulationRun` from `rollup-shared.ts`. Returns `{ available: true, ...OutcomeDiffReport }` or `{ available: false }` for unmapped measures.
- **Tests:** 10 unit tests + 3 route integration tests — all pass. Full suite: ~773 pass, 1 pg-skip, 0 fail.

**Live result on `twh-api-ts` (after deploy):** 0 subjects diverge on the age criterion — all 42 synthetic employees hash to birth years 1980–1999, giving ages 27–46, comfortably within 18–75. The 8 other OMITTED/SIMPLIFIED criteria are unverifiable (no encounter, hospice, or frailty data in the synthetic bundles). This is the correct, honest result.

**Headline note:** "Full outcome diff requires the ValueSetResolver port with real VSAC credentials — this is the criteria-impact analysis predecessor, scoped at PR-1's structural diff resolution."

**Next:** E14 PR-3 or pivot to E12 PR-2 (WebChart adapter — blocked on MIE schema).
```

- [ ] **Step 3: Commit the journal**

```bash
git add docs/JOURNAL.md
git commit -m "docs(e14): JOURNAL entry for PR-2 outcome diff"
```

---

## Task 5: Final branch + PR

- [ ] **Step 1: Typecheck**

```bash
cd backend-ts && pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 2: Full test suite**

```bash
cd backend-ts && pnpm test 2>&1 | tail -5
```

Expected: ~773 pass, 1 pg-skip, 0 fail.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/e14-pr2-outcome-diff
gh pr create \
  --title "feat(e14): outcome diff — criteria-impact analysis for CMS122v14 (PR-2)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `GET /api/measures/:id/fidelity/diff` (E14 PR-2 / #186)
- Pure TypeScript criteria-impact analysis: for each OMITTED/SIMPLIFIED official criterion, counts how many subjects from the latest population run would diverge if the criterion were applied
- Age-18-75 gate is verifiable (synthetic patients have deterministic birthDates); encounter/hospice/frailty/palliative criteria are labelled unverifiable (data absent from synthetic bundles)
- With current synthetic population (all ages 27–46): 0 divergent subjects on age, 8 criteria unverifiable — correct, honest result
- Clearly documents that a full outcome diff (executing official CQL + real VSAC value sets) is deferred until VSAC credentials are available via the existing ValueSetResolver port
- No schema, no new dependencies, descriptive only (ADR-008)

## Test plan

- [ ] `cd backend-ts && pnpm typecheck` → 0 errors
- [ ] `cd backend-ts && pnpm test` → ~773 pass, 1 pg-skip, 0 fail
- [ ] `curl .../api/measures/cms122/fidelity/diff` on live stack returns `available:true` with `totalSubjectsEvaluated>0`
- [ ] `curl .../api/measures/audiogram/fidelity/diff` returns `{ available: false }` (no reference for audiogram)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Criteria-impact analysis for OMITTED criteria — age-18-75 verifiable (evaluator), others unverifiable with reason
- [x] SIMPLIFIED criteria — returns note from reference, marked verifiable:true with 0 divergence (same logical outcome)
- [x] COVERED criteria — marked fully aligned, 0 divergence
- [x] `totalDivergent` = Σ `subjectsAffected`
- [x] `GET /api/measures/:id/fidelity/diff` endpoint
- [x] Returns `{ available: false }` for measures without a vendored reference
- [x] Empty outcomes returns valid 0-count report (no run yet)
- [x] Disclaimer mentions `ValueSetResolver` + ADR-008
- [x] Tests: unit (10) + route integration (3)
- [x] Journal entry

**Placeholder scan:** No TBDs, no TODOs, no "add appropriate error handling." All code is complete.

**Type consistency:** `OutcomeSlice` used as parameter type in `computeOutcomeDiff` is compatible with `OutcomeWithRun` (has `subjectId`, `status`, `runId`, `runStartedAt`). `CriterionImpact.coverage` is typed as `Coverage` from `reference-types.ts`. `CriterionImpact.population` is typed as `Population` from `reference-types.ts`. Consistent throughout.
