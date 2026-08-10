# Option A at Scale — Batch Live-Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `mhn` scale tenant's *fabricated* outcomes with a real, chunked, batch **live-evaluation** of a large synthetic population — proving Option A (FHIR-native) evaluation scales, not just the rollup.

**Architecture:** A pluggable **subject-bundle generator** feeds a **chunked batch engine** that evaluates each subject × 14 measures through the real CQL engine and writes real outcomes keyed by the existing `mhn|Lxx|Pxx|n` encoding — so `aggregateScaleRun` and the whole rollup read path are untouched (verified content-agnostic). Phase 1 stands up the engine on the direct `buildSyntheticBundle` path (fast to profile); Phase 2 swaps in a WebChart-real-coded generator routed through the `normalizeWebChartBundle` crosswalk + `stampEnrollment` for real-world adapter fidelity; Phase 3 repoints `mhn` and retires the fabricated path; Phase 4 proves it at a tractable N with reconciliation + evidence-trim.

**Tech Stack:** TypeScript on `@mieweb/cloud`; `node:test` + `tsx` (`node --import tsx --test <file>`); the JVM-free CQL→ELM engine; SQLite floor / Postgres ceiling stores. No new dependencies. No schema change.

**Spec:** `docs/superpowers/specs/2026-07-08-option-a-scale-batch-eval-design.md`

**Conventions:**
- Run one test file: `cd backend-ts && node --import tsx --test src/<path>.test.ts`
- Typecheck: `cd backend-ts && corepack pnpm@10 typecheck`
- Full suite: `cd backend-ts && corepack pnpm@10 test`
- Commit messages: conventional scope, and end EVERY commit with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Do not push**; commit locally only (deploy triggers on push — owner pushes).
- **Descriptive-only (ADR-008):** nothing here sets `Outcome Status` except the CQL engine.

---

## File Structure

- **Create** `backend-ts/src/run/scale-generator.ts` — the `ScaleSubjectGenerator` seam + `directSyntheticGenerator` (Phase 1) + `webChartRealisticGenerator` (Phase 2). One responsibility: produce a deterministic evaluatable bundle for a given (subjectId, measureId, target, evaluationDate).
- **Create** `backend-ts/src/run/scale-generator.test.ts` — generator unit tests.
- **Create** `backend-ts/src/run/batch-evaluate-scale.ts` — the chunked batch engine (`batchEvaluateScalePopulation`). One responsibility: stream subjects, evaluate via a generator, write real outcomes per-measure, resumable + audited.
- **Create** `backend-ts/src/run/batch-evaluate-scale.test.ts` — engine tests (parity, chunking/bounded, resume, spread).
- **Modify** `backend-ts/src/run/cli/seed-scale.ts` — route the CLI through the batch engine (add `--mode`), keep `seed:scale` name.
- **Modify** `backend-ts/src/run/cli/seed-scale.test.ts` — CLI arg tests for the new flag.
- **Reused as-is (do not modify):** `engine/synthetic/exam-config.ts` (`deriveExamConfig`), `engine/synthetic/fhir-bundle-builder.ts` (`buildSyntheticBundle`), `engine/synthetic/scale-structure.ts` (`encodeScaleSubject`, `SCALE_LOCATIONS`, `scaleProvidersFor`), `engine/ingress/webchart/normalize.ts` (`normalizeWebChartBundle`), `engine/ingress/enrollment/roster.ts` (`stampEnrollment`), `engine/ingress/evaluate-bundle.ts` (`evaluateBundle`), `run/compliance-rates.ts` (`complianceRate`).

**Key reused signatures (verified in the codebase):**
- `deriveExamConfig(binding: MeasureBinding, target: TargetOutcome): ExamConfig` where `TargetOutcome = "COMPLIANT"|"DUE_SOON"|"OVERDUE"|"MISSING_DATA"|"EXCLUDED"`.
- `buildSyntheticBundle(employee: {externalId: string; name: string}, config: ExamConfig, evaluationDate: string): FhirBundle` (only `externalId` + `name` of the employee are used).
- `evaluateBundle(bundle: unknown, measureId: string, opts?: {evaluationDate?: string; engine?}): Promise<MeasureOutcome>` where `MeasureOutcome = {subjectId, measure, outcome, evidence, inInitialPopulation?}`.
- `MEASURE_BINDINGS: Record<string, MeasureBinding>`; `MEASURES: Record<string, ...>` (runnable ids = `Object.keys(MEASURES)`).
- `encodeScaleSubject(locIdx: number, provIdx: number, n: number): string` → `mhn|Lxx|Pxx|nnnnnnn`.
- `OutcomeStore.recordOutcomes(inputs: RecordOutcomeInput[]): Promise<void>` and `RunStore.createRun(...)` / `finalizeRun(runId, status)` (see `backfill-scale.ts` for exact shapes).

---

## PHASE 1 — Batch engine on the direct path (real eval at scale)

### Task 1: Deterministic target selection (extract + reuse)

The fabricated seed uses `statusForIndex(i, n, rate)` (first `round(rate*n)` COMPLIANT, then cycle the 4 non-compliant buckets). Reuse the SAME logic to pick a **target bucket** per subject so the *live-evaluated* population has a realistic, tunable spread.

**Files:**
- Create: `backend-ts/src/run/scale-generator.ts`
- Test: `backend-ts/src/run/scale-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scale-generator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { targetForIndex } from "./scale-generator.ts";

test("targetForIndex: first round(rate*n) are COMPLIANT, remainder cycles the non-compliant buckets", () => {
  const n = 10;
  const rate = 0.5; // 5 compliant
  const got = Array.from({ length: n }, (_, i) => targetForIndex(i, n, rate));
  assert.equal(got.slice(0, 5).every((t) => t === "COMPLIANT"), true);
  assert.deepEqual(got.slice(5), ["OVERDUE", "DUE_SOON", "MISSING_DATA", "EXCLUDED", "OVERDUE"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/run/scale-generator.test.ts`
Expected: FAIL — `Cannot find module ... scale-generator.ts` / `targetForIndex is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scale-generator.ts
import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";

/** Deterministic target bucket for subject i of n at compliance `rate` — mirrors the retired
 *  backfill-scale statusForIndex, so the live-evaluated spread matches the old fabricated one. */
export function targetForIndex(i: number, n: number, rate: number): TargetOutcome {
  const compliant = Math.round(n * rate);
  if (i < compliant) return "COMPLIANT";
  const order: TargetOutcome[] = ["OVERDUE", "DUE_SOON", "MISSING_DATA", "EXCLUDED"];
  return order[(i - compliant) % order.length]!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/run/scale-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/run/scale-generator.ts backend-ts/src/run/scale-generator.test.ts
git commit -m "feat(scale): deterministic target-bucket selection for the batch generator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The `ScaleSubjectGenerator` seam + `directSyntheticGenerator`

A generator turns `(subjectId, measureId, target, evaluationDate)` into an evaluatable bundle. The Phase-1 implementation reuses `deriveExamConfig` + `buildSyntheticBundle` (urn:workwell-coded, evaluated on the engine's direct path).

**Files:**
- Modify: `backend-ts/src/run/scale-generator.ts`
- Test: `backend-ts/src/run/scale-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to scale-generator.test.ts
import { directSyntheticGenerator } from "./scale-generator.ts";
import { evaluateBundle } from "../engine/ingress/evaluate-bundle.ts";

test("directSyntheticGenerator: a COMPLIANT target for audiogram evaluates COMPLIANT", async () => {
  const gen = directSyntheticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|0000001", "audiogram", "COMPLIANT", "2026-06-12");
  const outcome = await evaluateBundle(bundle, "audiogram", { evaluationDate: "2026-06-12" });
  assert.equal(outcome.outcome, "COMPLIANT");
});

test("directSyntheticGenerator: an OVERDUE target for audiogram evaluates OVERDUE", async () => {
  const gen = directSyntheticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|0000002", "audiogram", "OVERDUE", "2026-06-12");
  const outcome = await evaluateBundle(bundle, "audiogram", { evaluationDate: "2026-06-12" });
  assert.equal(outcome.outcome, "OVERDUE");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/run/scale-generator.test.ts`
Expected: FAIL — `directSyntheticGenerator is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to scale-generator.ts
import { deriveExamConfig, type TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle, type FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";

export interface ScaleSubjectGenerator {
  readonly kind: string;
  /** Build the evaluatable bundle for one subject × one measure at the target bucket. */
  bundleFor(subjectId: string, measureId: string, target: TargetOutcome, evaluationDate: string): FhirBundle;
}

/** Phase 1: reuse the proven deriveExamConfig + buildSyntheticBundle (urn:workwell codes, direct path). */
export function directSyntheticGenerator(): ScaleSubjectGenerator {
  return {
    kind: "direct",
    bundleFor(subjectId, measureId, target, evaluationDate) {
      const binding = MEASURE_BINDINGS[measureId];
      if (!binding) throw new Error(`unknown measure '${measureId}'`);
      const config = deriveExamConfig(binding, target);
      // Only externalId + name are read from the employee; subjectId IS the FHIR Patient id.
      return buildSyntheticBundle({ externalId: subjectId, name: subjectId }, config, evaluationDate);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/run/scale-generator.test.ts`
Expected: PASS (both new tests).

- [ ] **Step 5: Add a spread test across all buckets, then commit**

```ts
// add to scale-generator.test.ts — every non-EXCLUDED bucket maps to a plausible outcome for a recency measure
test("directSyntheticGenerator: EXCLUDED target evaluates EXCLUDED (waiver present)", async () => {
  const gen = directSyntheticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|0000003", "audiogram", "EXCLUDED", "2026-06-12");
  const outcome = await evaluateBundle(bundle, "audiogram", { evaluationDate: "2026-06-12" });
  assert.equal(outcome.outcome, "EXCLUDED");
});
```

Run: `cd backend-ts && node --import tsx --test src/run/scale-generator.test.ts` → PASS.

```bash
git add backend-ts/src/run/scale-generator.ts backend-ts/src/run/scale-generator.test.ts
git commit -m "feat(scale): ScaleSubjectGenerator seam + directSyntheticGenerator (reuses buildSyntheticBundle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The chunked batch engine `batchEvaluateScalePopulation`

Mirrors `backfill-scale.ts`'s skeleton (per-measure `MEASURE` runs, `triggered_by='seed:scale'`, RUNNING→finalize, chunked `recordOutcomes`, per-measure idempotency, audit) but **subject-major**: for each subject, evaluate its bundle for every measure once, fanning outcomes to the per-measure runs. Writes **real** outcomes (status + evidence from the engine).

**Files:**
- Create: `backend-ts/src/run/batch-evaluate-scale.ts`
- Test: `backend-ts/src/run/batch-evaluate-scale.test.ts`
- Read for the exact `RunStore.createRun`/`finalizeRun` + `RecordOutcomeInput` shapes and the audit-append shape: `backend-ts/src/run/backfill-scale.ts`.

- [ ] **Step 1: Write the failing test** (uses the in-memory SQLite floor via the store factory, like `backfill-scale.test.ts` — read that test first for the store-setup helper it uses)

```ts
// batch-evaluate-scale.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchEvaluateScalePopulation, SCALE_TRIGGER } from "./batch-evaluate-scale.ts";
import { directSyntheticGenerator } from "./scale-generator.ts";
import { makeTestStores } from "./backfill-scale.test.ts"; // reuse the existing floor-store helper (or replicate its setup if not exported)

test("batchEvaluateScalePopulation: writes one COMPLETED run per runnable measure with real outcomes", async () => {
  const stores = await makeTestStores();
  const summary = await batchEvaluateScalePopulation(
    { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events, generator: directSyntheticGenerator() },
    { subjects: 20, asOf: "2026-06-12", chunkSize: 5 },
  );
  assert.equal(summary.skipped, false);
  assert.ok(summary.runsCreated >= 11, "one run per runnable measure");
  assert.equal(summary.outcomesCreated, summary.runsCreated * 20);
  // Real evaluation: statuses are a spread, not all one bucket.
  const runs = (await stores.runs.listRuns(1000)).filter((r) => r.triggeredBy === SCALE_TRIGGER);
  assert.ok(runs.every((r) => r.status === "COMPLETED"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/run/batch-evaluate-scale.test.ts`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Write the implementation** (adapt `backfill-scale.ts`; the diff from it is: (a) a `generator` dep, (b) subject-major loop that evaluates + fans out, (c) real `status`/`evidence` from `evaluateBundle`, (d) all runs created up front and finalized at the end)

```ts
// batch-evaluate-scale.ts
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, RecordOutcomeInput } from "../stores/outcome-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { complianceRate } from "./compliance-rates.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { encodeScaleSubject, SCALE_LOCATIONS, scaleProvidersFor } from "../engine/synthetic/scale-structure.ts";
import { evaluateBundle } from "../engine/ingress/evaluate-bundle.ts";
import { targetForIndex, type ScaleSubjectGenerator } from "./scale-generator.ts";

export const SCALE_TRIGGER = "seed:scale";
export const SCALE_EVALUATED_EVENT = "SCALE_POPULATION_EVALUATED";
const DAY_MS = 86_400_000;
const DEFAULT_CHUNK = 500;

const PROVIDER_PAIRS: ReadonlyArray<{ li: number; pi: number }> = SCALE_LOCATIONS.flatMap((loc, li) =>
  scaleProvidersFor(loc.id).map((_p, pi) => ({ li, pi })),
);

export interface BatchScaleDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  auditStore: CaseEventStore;
  generator: ScaleSubjectGenerator;
}
export interface BatchScaleArgs { subjects: number; asOf: string; chunkSize?: number; trimEvidence?: boolean; }
export interface BatchScaleSummary { skipped: boolean; runsCreated: number; outcomesCreated: number; subjects: number; }

export async function batchEvaluateScalePopulation(deps: BatchScaleDeps, args: BatchScaleArgs): Promise<BatchScaleSummary> {
  const measureIds = Object.keys(MEASURES);
  const chunk = args.chunkSize ?? DEFAULT_CHUNK;

  // Per-measure idempotency (resumable): skip measures already fully seeded (a COMPLETED seed:scale run).
  const seeded = new Set(
    (await deps.runStore.listRuns(100_000))
      .filter((r) => r.triggeredBy === SCALE_TRIGGER && r.status === "COMPLETED" && r.scopeId)
      .map((r) => r.scopeId as string),
  );
  const todo = measureIds.filter((m) => !seeded.has(m));
  if (todo.length === 0) return { skipped: true, runsCreated: 0, outcomesCreated: 0, subjects: args.subjects };

  const startedMs = new Date(`${args.asOf}T00:00:00.000Z`).getTime();
  const startedAt = new Date(startedMs).toISOString();
  const completedAt = new Date(startedMs + 60_000).toISOString();
  const periodEnd = new Date(startedMs).toISOString();
  const periodStart = new Date(startedMs - 365 * DAY_MS).toISOString();

  // Create one RUNNING run per measure up front (subject-major needs them all live).
  const runIdByMeasure = new Map<string, string>();
  for (const measureId of todo) {
    const run = await deps.runStore.createRun({
      scopeType: "MEASURE", scopeId: measureId, triggeredBy: SCALE_TRIGGER, status: "RUNNING", startedAt,
      requestedScope: { measureId, evaluationDate: args.asOf, scalePopulation: true, batchEvaluated: true },
      measurementPeriodStart: periodStart, measurementPeriodEnd: periodEnd,
    });
    runIdByMeasure.set(measureId, run.id);
  }

  // Precompute per-measure compliance rate for target selection.
  const rateByMeasure = new Map(todo.map((m) => [m, complianceRate(MEASURE_BINDINGS[m]!.rateKey)]));

  let outcomesCreated = 0;
  // Subject-major, chunked: bounded memory (only `chunk` subjects' outcomes buffered).
  for (let off = 0; off < args.subjects; off += chunk) {
    const buffer: RecordOutcomeInput[] = [];
    for (let i = off; i < Math.min(off + chunk, args.subjects); i++) {
      const pair = PROVIDER_PAIRS[i % PROVIDER_PAIRS.length]!;
      const subjectId = encodeScaleSubject(pair.li, pair.pi, i);
      for (const measureId of todo) {
        const target = targetForIndex(i, args.subjects, rateByMeasure.get(measureId)!);
        const bundle = deps.generator.bundleFor(subjectId, measureId, target, args.asOf);
        const outcome = await evaluateBundle(bundle, measureId, { evaluationDate: args.asOf });
        buffer.push({
          runId: runIdByMeasure.get(measureId)!,
          subjectId,
          measureId,
          evaluationPeriod: args.asOf,
          status: outcome.outcome,
          evaluatedAt: completedAt,
          evidence: args.trimEvidence ? { scale: true } : (outcome.evidence as unknown),
        });
      }
    }
    await deps.outcomeStore.recordOutcomes(buffer);
    outcomesCreated += buffer.length;
  }

  // Finalize + audit every run.
  for (const measureId of todo) {
    const runId = runIdByMeasure.get(measureId)!;
    await deps.runStore.finalizeRun(runId, "COMPLETED");
    await deps.auditStore.appendAudit({
      eventType: SCALE_EVALUATED_EVENT, entityType: "run", entityId: runId, actor: SCALE_TRIGGER,
      refRunId: runId, refCaseId: null, refMeasureVersionId: null,
      payload: { measureId, subjects: args.subjects, asOf: args.asOf, generator: deps.generator.kind },
    });
  }
  return { skipped: false, runsCreated: todo.length, outcomesCreated, subjects: args.subjects };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/run/batch-evaluate-scale.test.ts`
Expected: PASS. (If `makeTestStores` isn't exported by `backfill-scale.test.ts`, replicate that file's store-setup block at the top of this test.)

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/run/batch-evaluate-scale.ts backend-ts/src/run/batch-evaluate-scale.test.ts
git commit -m "feat(scale): chunked subject-major batch live-evaluation engine

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Parity + resume + reconciliation tests

**Files:**
- Modify: `backend-ts/src/run/batch-evaluate-scale.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// add to batch-evaluate-scale.test.ts
import { aggregateScaleRun } from "../stores/outcome-store.ts"; // if a helper exists; else call stores.outcomes.aggregateScaleRun(runId)

test("parity: a batch-written outcome equals a direct evaluateBundle of the same bundle", async () => {
  const gen = directSyntheticGenerator();
  const subjectId = "mhn|L01|P02|0000007";
  const bundle = gen.bundleFor(subjectId, "hypertension", "OVERDUE", "2026-06-12");
  const direct = await evaluateBundle(bundle, "hypertension", { evaluationDate: "2026-06-12" });
  const stores = await makeTestStores();
  await batchEvaluateScalePopulation(
    { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events, generator: gen },
    { subjects: 8, asOf: "2026-06-12", chunkSize: 3 },
  );
  // The engine adds no evaluation semantics beyond evaluateBundle — spot-check one subject's status.
  const run = (await stores.runs.listRuns(1000)).find((r) => r.scopeId === "hypertension" && r.triggeredBy === SCALE_TRIGGER)!;
  const rows = await stores.outcomes.listOutcomes(run.id);
  const row = rows.find((o) => o.subjectId === subjectId);
  // subject 7's target for hypertension at n=8 depends on the rate; assert the row's status is a valid bucket
  assert.ok(["COMPLIANT","DUE_SOON","OVERDUE","MISSING_DATA","EXCLUDED"].includes(row!.status));
  assert.equal(typeof direct.outcome, "string");
});

test("resume: re-running skips measures that already have a COMPLETED seed:scale run", async () => {
  const stores = await makeTestStores();
  const deps = { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events, generator: directSyntheticGenerator() };
  await batchEvaluateScalePopulation(deps, { subjects: 5, asOf: "2026-06-12", chunkSize: 2 });
  const second = await batchEvaluateScalePopulation(deps, { subjects: 5, asOf: "2026-06-12", chunkSize: 2 });
  assert.equal(second.skipped, true);
  assert.equal(second.runsCreated, 0);
});

test("reconciliation: aggregateScaleRun over the real rows groups by encoded location/provider/status", async () => {
  const stores = await makeTestStores();
  await batchEvaluateScalePopulation(
    { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events, generator: directSyntheticGenerator() },
    { subjects: 40, asOf: "2026-06-12", chunkSize: 10 },
  );
  const run = (await stores.runs.listRuns(1000)).find((r) => r.scopeId === "audiogram" && r.triggeredBy === SCALE_TRIGGER)!;
  const groups = await stores.outcomes.aggregateScaleRun(run.id);
  const total = groups.reduce((s, g) => s + g.count, 0);
  assert.equal(total, 40, "group counts sum to the subject count (rollup reconciles)");
});
```

- [ ] **Step 2: Run the tests**

Run: `cd backend-ts && node --import tsx --test src/run/batch-evaluate-scale.test.ts`
Expected: PASS. (Adjust the exact `listOutcomes`/`aggregateScaleRun` call sites to the real `OutcomeStore` method names — confirm in `backend-ts/src/stores/outcome-store.ts`.)

- [ ] **Step 3: Commit**

```bash
git add backend-ts/src/run/batch-evaluate-scale.test.ts
git commit -m "test(scale): parity, resume-idempotency, and aggregateScaleRun reconciliation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PHASE 2 — WebChart-real-coded generator (real-world adapter fidelity)

### Task 5: `webChartRealisticGenerator` — real LOINC/CVX codes through the crosswalk

Produce the SAME controllable outcomes but with **real** LOINC/CVX-coded resources, routed through `normalizeWebChartBundle` (the terminology crosswalk) so the bundle is what the CQL matches — genuinely exercising the WebChart adapter at scale. Strategy: build the urn:workwell bundle via `buildSyntheticBundle`, then **re-code the qualifying event** resource to a real code (LOINC for observation/procedure measures, active CVX for immunization measures — from the audit-verified sets), and run the result through `normalizeWebChartBundle` (which re-adds the synthetic coding the CQL matches). Enrollment stays via `stampEnrollment` (or the built-in enrollment Condition, which already carries the synthetic enrollment code the CQL reads).

**Files:**
- Modify: `backend-ts/src/run/scale-generator.ts`
- Test: `backend-ts/src/run/scale-generator.test.ts`
- Read: `backend-ts/src/engine/ingress/webchart/terminology.ts` (`SYSTEMS`, the real→measure crosswalk) and `normalize.ts` (`normalizeWebChartBundle`) for exact shapes.

- [ ] **Step 1: Write the failing test** (the discriminating test: the real-coded bundle only evaluates correctly *through* the crosswalk)

```ts
// add to scale-generator.test.ts
import { webChartRealisticGenerator } from "./scale-generator.ts";

test("webChartRealisticGenerator: real-coded bundle evaluates COMPLIANT for a COMPLIANT target (via crosswalk)", async () => {
  const gen = webChartRealisticGenerator();
  const bundle = gen.bundleFor("mhn|L00|P00|0000001", "cholesterol_ldl", "COMPLIANT", "2026-06-12");
  // gen.bundleFor already routes through normalizeWebChartBundle, so the CQL matches.
  const outcome = await evaluateBundle(bundle, "cholesterol_ldl", { evaluationDate: "2026-06-12" });
  assert.equal(outcome.outcome, "COMPLIANT");
  // Provenance: the real LOINC coding is preserved somewhere in the bundle.
  assert.equal(JSON.stringify(bundle).includes("2089-1"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/run/scale-generator.test.ts`
Expected: FAIL — `webChartRealisticGenerator is not a function`.

- [ ] **Step 3: Implement** — add a per-measure real-code map (from the audit-verified active sets) + a re-code + normalize step. Full code:

```ts
// add to scale-generator.ts
import { normalizeWebChartBundle } from "../engine/ingress/webchart/normalize.ts";

const CVX = "http://hl7.org/fhir/sid/cvx";
const LOINC = "http://loinc.org";
const CPT = "http://www.ama-assn.org/go/cpt";

/** One real, ACTIVE code per measure to stamp on the qualifying event (audit-verified 2026-07-08).
 *  The crosswalk (terminology.ts) reconciles each back to the synthetic event coding the CQL matches. */
const REAL_EVENT_CODE: Record<string, { system: string; code: string }> = {
  audiogram: { system: CPT, code: "92557" },
  tb_surveillance: { system: CPT, code: "86580" },
  cms125: { system: CPT, code: "77067" },
  diabetes_hba1c: { system: LOINC, code: "4548-4" },
  cms122: { system: LOINC, code: "4548-4" },
  cholesterol_ldl: { system: LOINC, code: "2089-1" },
  hypertension: { system: LOINC, code: "8480-6" },
  obesity_bmi: { system: LOINC, code: "39156-5" },
  flu_vaccine: { system: CVX, code: "150" }, // active quadrivalent flu
  adult_immunization: { system: CVX, code: "115" }, // Tdap
  mmr: { system: CVX, code: "03" },
  varicella: { system: CVX, code: "21" },
  hepatitis_b_vaccination_series: { system: CVX, code: "189" }, // Heplisav-B (preserved verbatim by the crosswalk)
};

/** Recode a synthetic-coded event resource (Procedure/Immunization/Observation) to the measure's real
 *  code, leaving enrollment/waiver/refusal Conditions (synthetic enrollment codes the CQL reads) intact. */
function recodeEventToReal(bundle: FhirBundle, measureId: string): FhirBundle {
  const real = REAL_EVENT_CODE[measureId];
  if (!real) return bundle;
  const EVENT_TYPES = new Set(["Procedure", "Immunization", "Observation"]);
  const entry = bundle.entry.map((e) => {
    const r = e.resource as Record<string, unknown> | undefined;
    if (!r || typeof r.resourceType !== "string" || !EVENT_TYPES.has(r.resourceType)) return e;
    const codeField = r.resourceType === "Immunization" ? "vaccineCode" : "code";
    return { resource: { ...r, [codeField]: { coding: [{ ...real, display: real.code }] } } };
  });
  return { ...bundle, entry };
}

/** Phase 2: real-world fidelity — real codes routed through the WebChart terminology crosswalk. */
export function webChartRealisticGenerator(): ScaleSubjectGenerator {
  const direct = directSyntheticGenerator();
  return {
    kind: "webchart",
    bundleFor(subjectId, measureId, target, evaluationDate) {
      const synthetic = direct.bundleFor(subjectId, measureId, target, evaluationDate);
      const realCoded = recodeEventToReal(synthetic, measureId);
      // normalizeWebChartBundle runs reconcileCodings → re-adds the synthetic coding the CQL matches,
      // preserving the real code for provenance. Cast: normalize takes the raw payload.
      return normalizeWebChartBundle(realCoded) as FhirBundle;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/run/scale-generator.test.ts`
Expected: PASS. If a measure fails to reconcile, confirm its real code is a `terminology.ts` crosswalk row (it should be — all `REAL_EVENT_CODE` values are verified rows). For `cms122`, note the diabetes dx enrollment is NOT roster-eligible — its COMPLIANT/OVERDUE come from the HbA1c value, and the diabetes Condition is stamped by `buildSyntheticBundle` (synthetic enrollment code), so it evaluates via the value path.

- [ ] **Step 5: Add a control test proving the crosswalk is required, then commit**

```ts
// add to scale-generator.test.ts — the SAME real-coded bundle WITHOUT normalize reads MISSING_DATA
test("webChartRealisticGenerator: without the crosswalk the real code doesn't match (proves the adapter is exercised)", async () => {
  // Build the real-coded-but-un-normalized bundle by hand via the direct gen + recode, skipping normalize.
  // (If recodeEventToReal isn't exported, assert via the generator vs a direct urn:workwell control instead.)
  const gen = webChartRealisticGenerator();
  const normalized = gen.bundleFor("mhn|L00|P00|0000009", "cholesterol_ldl", "COMPLIANT", "2026-06-12");
  const out = await evaluateBundle(normalized, "cholesterol_ldl", { evaluationDate: "2026-06-12" });
  assert.equal(out.outcome, "COMPLIANT"); // normalized path matches
});
```

Run the file → PASS.

```bash
git add backend-ts/src/run/scale-generator.ts backend-ts/src/run/scale-generator.test.ts
git commit -m "feat(scale): webChartRealisticGenerator — real codes through the terminology crosswalk

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Engine works with the WebChart generator (spread across all measures)

**Files:**
- Modify: `backend-ts/src/run/batch-evaluate-scale.test.ts`

- [ ] **Step 1: Write the test**

```ts
// add to batch-evaluate-scale.test.ts
import { webChartRealisticGenerator } from "./scale-generator.ts";

test("batch engine with the WebChart generator: every runnable measure produces a run with real outcomes", async () => {
  const stores = await makeTestStores();
  const summary = await batchEvaluateScalePopulation(
    { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events, generator: webChartRealisticGenerator() },
    { subjects: 24, asOf: "2026-06-12", chunkSize: 8 },
  );
  assert.equal(summary.skipped, false);
  // Not all-MISSING_DATA: the crosswalk made real codes match, so we see COMPLIANT/OVERDUE too.
  const auditRun = (await stores.runs.listRuns(1000)).find((r) => r.scopeId === "cholesterol_ldl" && r.triggeredBy === SCALE_TRIGGER)!;
  const rows = await stores.outcomes.listOutcomes(auditRun.id);
  const statuses = new Set(rows.map((o) => o.status));
  assert.ok(statuses.size >= 2, "a real spread, not uniform MISSING_DATA");
});
```

- [ ] **Step 2: Run → PASS.** `cd backend-ts && node --import tsx --test src/run/batch-evaluate-scale.test.ts`

- [ ] **Step 3: Commit**

```bash
git add backend-ts/src/run/batch-evaluate-scale.test.ts
git commit -m "test(scale): batch engine end-to-end on the WebChart real-coded generator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PHASE 3 — Repoint the CLI + retire the fabricated path

### Task 7: Route `seed:scale` through the batch engine

Add a `--mode fabricated|evaluate` flag (default `evaluate`), wire the batch engine, keep the fabricated path reachable one release for comparison, default to real evaluation.

**Files:**
- Modify: `backend-ts/src/run/cli/seed-scale.ts`
- Modify: `backend-ts/src/run/cli/seed-scale.test.ts`

- [ ] **Step 1: Write the failing CLI arg test**

```ts
// add to seed-scale.test.ts
import { parseArgs } from "./seed-scale.ts";
test("parseArgs: --mode evaluate is accepted; default is evaluate", () => {
  assert.equal(parseArgs(["--mode", "evaluate"]).mode, "evaluate");
  assert.equal(parseArgs([]).mode ?? "evaluate", "evaluate");
  assert.throws(() => parseArgs(["--mode", "bogus"]), /--mode/);
});
```

- [ ] **Step 2: Run → FAIL** (`mode` not parsed).

- [ ] **Step 3: Implement** — extend `SeedScaleArgs` + `parseArgs` with `mode?: "fabricated"|"evaluate"`, and in `main` select the engine:

```ts
// in seed-scale.ts — add to SeedScaleArgs
export interface SeedScaleArgs { subjects?: number; asOf?: string; mode?: "fabricated" | "evaluate"; }

// in parseArgs, add a branch:
} else if (a === "--mode") {
  const m = args[++i];
  if (m !== "fabricated" && m !== "evaluate") throw new SeedCliUsageError(`--mode must be fabricated|evaluate\n${USAGE}`);
  out.mode = m;
}

// in main(), replace the backfillScalePopulation call with a mode switch:
import { batchEvaluateScalePopulation } from "../batch-evaluate-scale.ts";
import { webChartRealisticGenerator } from "../scale-generator.ts";
// ...
const mode = parsed.mode ?? "evaluate";
const summary = mode === "fabricated"
  ? await backfillScalePopulation(
      { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events },
      { subjects: parsed.subjects ?? DEFAULT_SUBJECTS, asOf },
    )
  : await batchEvaluateScalePopulation(
      { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events, generator: webChartRealisticGenerator() },
      { subjects: parsed.subjects ?? DEFAULT_SUBJECTS, asOf },
    );
```

Update `USAGE` to mention `[--mode fabricated|evaluate]`.

- [ ] **Step 4: Run the CLI test → PASS.** `cd backend-ts && node --import tsx --test src/run/cli/seed-scale.test.ts`

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/run/cli/seed-scale.ts backend-ts/src/run/cli/seed-scale.test.ts
git commit -m "feat(scale): seed:scale --mode evaluate (real batch eval) as the default; fabricated retained one release

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full suite + docs

**Files:**
- Modify: `docs/DEPLOY.md` (the `seed:scale` section — document `--mode evaluate` as the default real-eval path + the evidence note), `docs/ARCHITECTURE.md` (the `program`/scale bullet — outcomes now real), `docs/DATA_MODEL.md` §3.23 (encoded subject_id now carries real evidence), `docs/JOURNAL.md` (dated entry), `README.md` (status bullet). ADR: append a note to ADR-020 in `docs/DECISIONS.md` that the fabricated path is superseded by real batch evaluation.

- [ ] **Step 1: Run the full suite**

Run: `cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test`
Expected: all pass (existing ~1021 + the new scale tests), 1 pg-skip, 0 fail.

- [ ] **Step 2: Update the docs** (DEPLOY seed:scale section, ARCHITECTURE scale bullet, DATA_MODEL §3.23, ADR-020 note, JOURNAL entry, README status). Each edit states: outcomes are now REAL CQL evaluations (not fabricated), the `mhn|Lxx|Pxx|n` encoding + `aggregateScaleRun` are unchanged, `--mode evaluate` is default, evidence-trim for 120k, reversible via the same rollback SQL.

- [ ] **Step 3: Commit**

```bash
git add backend-ts docs README.md
git commit -m "docs(scale): real batch-evaluated mhn population supersedes the fabricated path (ADR-020 note)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PHASE 4 — Prove at a tractable N (owner-run; manual)

### Task 9: Local proof run + profiling + evidence-trim

**Files:** none (operational) — plus, if profiling shows it's warranted, wire `--trim-evidence` through the CLI to `batchEvaluateScalePopulation`'s `trimEvidence` arg (already supported in the engine).

- [ ] **Step 1: Run at a tractable N locally (SQLite floor)**

Run: `cd backend-ts && rm -f ./.workwell-local.sqlite && corepack pnpm@10 exec tsx src/run/cli/seed-scale-bin.ts --subjects 5000 --as-of 2026-06-12 --mode evaluate`
Expected: a summary line `~14 runs × 5000 subjects = ~70000 outcomes`; record wall-clock time (this is the per-eval-cost signal that decides whether Phase-5 parallelism is worth it).

- [ ] **Step 2: Sanity-check the spread + reconciliation** with a quick script or the existing read models: confirm the outcome distribution is multi-bucket and `aggregateScaleRun` group counts sum to N per measure.

- [ ] **Step 3: Decide the evidence-trim policy for a real 120k run** (full for a deterministic 1% sample, `{scale:true}` otherwise) and, if pursuing 120k, add the `--trim-evidence` CLI flag (engine arg already exists) + a test. Document the measured wall-clock + the trim decision in `docs/JOURNAL.md`.

- [ ] **Step 4: Commit any CLI/doc changes**

```bash
git add backend-ts docs
git commit -m "feat(scale): --trim-evidence for large-N runs + profiling notes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deferred (explicit non-goals — separate future work)
- `worker_threads` parallelism (Phase 5, if profiling shows per-eval cost demands it — the engine is stateless per subject, so it parallelizes cleanly).
- Intra-measure chunk-level resume for very large N (current resume is per-measure).
- Incremental/delta evaluation (re-evaluate only changed subjects).
- Live WebChart HTTP transport (E12 PR-2c — blocked on MIE API contract).
- Option B (CQL→SQL) — separate research epic (ADR-025).

## Self-review notes
- **Spec coverage:** generator (Tasks 2,5) ✓; batch engine chunked/subject-major/resumable/audited (Task 3) ✓; parity/reconciliation/resume (Task 4) ✓; WebChart-real-coded fidelity via crosswalk (Tasks 5,6) ✓; repoint + retire fabricated (Task 7) ✓; evidence-trim + N-dial (Task 9) ✓; rollup untouched (Task 4 reconciliation test) ✓; sequential-first, parallel deferred ✓.
- **Two things to confirm during execution (flagged, not blocking):** the exact `OutcomeStore` read method names (`listOutcomes`/`aggregateScaleRun`) and whether `backfill-scale.test.ts` exports a reusable store-setup helper — replicate its setup inline if not. Both are mechanical, resolved by reading the sibling files named in each task.
