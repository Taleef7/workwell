# MM-1 U1 — Five Vendored ACO Measures Live on Maui: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo the execution mode is **one GLM 5.3 Flash lane per task** (one change per lane, `model_reasoning_effort=xhigh`), orchestrator-reviewed, cross-family review (Gemini 3.8 Flash high or Sol high, one per review) at Tier 2+.

**Spec:** `docs/superpowers/specs/2026-09-04-mm1-five-measures-live-design.md` (sections cited as §N below). Read it first; this plan does not restate its reasoning.

**Goal:** cms122, cms125, cms2, cms130, cms165 evaluate through the official executor on the Maui profile over a calendar-year measurement period, appear Active with official-aware wording, and flip live on the Maui deploy + reconcile workflows once each clears its verification debt.

**Architecture:** A pure runnable-classification rule in `config/` (clause (a) authored, clause (b) official-only, env read at call time); a `SubjectBundleSource` seam the run pipeline calls instead of reaching into `MEASURE_BINDINGS`; three hand-written QI-Core bundle shapes for the official-only measures; the calendar-year period in one shared function; a per-measure display table the roster/case/card readers consult; an `official-flip-gate` CLI that reports and never gates.

**Tech Stack:** TypeScript on `@mieweb/cloud`; node test runner via tsx (`node --import tsx --test <globs>`; the gate is `corepack pnpm@10 typecheck && corepack pnpm@10 test` in `backend-ts/`); frontend Next.js 16 / vitest (`corepack pnpm@10 lint && pnpm test && pnpm build` in `frontend/`).

**Standing rules for every task:** no new dependencies; no attribution lines in commits/PRs; "Maui" and "the pilot group" only; minimal diffs; conventional commits; `node_modules` present in the worktree, reinstall only with `corepack pnpm@10 install --frozen-lockfile`; never touch `backend-ts/src/stores/**/schema*.ts`, `.github/workflows/`, `docs/transcripts/`; delegates do not commit — the orchestrator commits with explicit paths.

**Run any single test file with:** `cd backend-ts && node --import tsx --test src/path/to/file.test.ts`. Expected output ends with `# pass N` / `# fail 0`.

---

## PR 1 — `feat/mm1-official-only-runnable` (Tasks 1–7)

### Task 1: The runnable rule (§3)

**Files:**
- Create: `backend-ts/src/config/official-measure-ids.ts`
- Modify: `backend-ts/src/config/deployment-profile.ts:30-57` (validation block), `:122-126` (`RUNNABLE_MEASURE_IDS`, `isRunnableMeasure`)
- Test: `backend-ts/src/config/official-measure-ids.test.ts` (create), `backend-ts/src/config/deployment-profile.test.ts` (extend)

- [ ] **Step 1: Write the failing test for the vendored-id listing**

`backend-ts/src/config/official-measure-ids.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VENDORED_OFFICIAL_MEASURE_IDS, isVendoredOfficialMeasure } from "./official-measure-ids.ts";

const dir = fileURLToPath(new URL("../../measures/official/", import.meta.url));

test("the vendored id list is exactly the directory listing under measures/official (sorted)", () => {
  const expected = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual([...VENDORED_OFFICIAL_MEASURE_IDS], expected);
  assert.ok(expected.includes("cms2") && expected.includes("cms130") && expected.includes("cms165"));
});

test("isVendoredOfficialMeasure is a plain membership test, immune to inherited keys", () => {
  assert.equal(isVendoredOfficialMeasure("cms122"), true);
  assert.equal(isVendoredOfficialMeasure("constructor"), false);
  assert.equal(isVendoredOfficialMeasure("cms137"), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/config/official-measure-ids.test.ts`
Expected: FAIL — `Cannot find module './official-measure-ids.ts'`.

- [ ] **Step 3: Implement the listing module**

`backend-ts/src/config/official-measure-ids.ts`:
```ts
/**
 * The ids of every vendored official artifact — the directory names under `measures/official/`.
 *
 * `config/` must not import `standards/official-cases.ts` (its header declares it diagnostic-only,
 * ADR-026, and it must stay off the boot path). The gated set is instead read off the filesystem,
 * which is sound because `official-gate.test.ts` pins OFFICIAL_GATED_MEASURES === this listing. One
 * readdirSync at module load; no JSON is parsed here.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OFFICIAL_ROOT = fileURLToPath(new URL("../../measures/official/", import.meta.url));

export const VENDORED_OFFICIAL_MEASURE_IDS: ReadonlySet<string> = new Set(
  readdirSync(OFFICIAL_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(),
);

export const isVendoredOfficialMeasure = (id: string): boolean => VENDORED_OFFICIAL_MEASURE_IDS.has(id);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/config/official-measure-ids.test.ts` → `# pass 2`.

- [ ] **Step 5: Write the failing tests for `classifyRunnable` and the Maui list**

Append to `backend-ts/src/config/deployment-profile.test.ts` (it already imports `runProfileChild` from `../test-support/run-profile-child.ts` and `resolveDeploymentProfile`):
```ts
import { classifyRunnable } from "./deployment-profile.ts";

test("classifyRunnable: authored, official, official-pending, invalid — env read at call time", () => {
  assert.deepEqual(classifyRunnable("audiogram", {}), { kind: "authored" });
  assert.deepEqual(classifyRunnable("cms165", { WORKWELL_OFFICIAL_MEASURES: "cms122,cms165" }), { kind: "official" });
  const pending = classifyRunnable("cms165", {});
  assert.equal(pending.kind, "official-pending");
  assert.match((pending as { reason: string }).reason, /WORKWELL_OFFICIAL_MEASURES/);
  const invalid = classifyRunnable("cms137", {});
  assert.equal(invalid.kind, "invalid");
  assert.match((invalid as { reason: string }).reason, /not vendored/);
  // cms122 is authored AND official: routed ⇒ official, unrouted ⇒ authored (the pre-flip state)
  assert.deepEqual(classifyRunnable("cms122", {}), { kind: "authored" });
  assert.deepEqual(classifyRunnable("cms122", { WORKWELL_OFFICIAL_MEASURES: "cms122" }), { kind: "official" });
});

test("the Maui profile lists exactly the five ACO measures, and hypertension is gone", () => {
  assert.deepEqual([...resolveDeploymentProfile("maui").runnableMeasureIds], ["cms122", "cms125", "cms2", "cms130", "cms165"]);
});

test("on the maui profile an unrouted official-only id is NOT runnable; a routed one is", () => {
  const script = `
    import { isRunnableMeasure, RUNNABLE_MEASURE_IDS } from "./src/config/deployment-profile.ts";
    console.log(JSON.stringify({ cms165: isRunnableMeasure("cms165"), cms122: isRunnableMeasure("cms122"), listed: RUNNABLE_MEASURE_IDS }));
  `;
  const unrouted = runProfileChild("maui", script) as { cms165: boolean; cms122: boolean; listed: string[] };
  assert.equal(unrouted.cms165, false);
  assert.equal(unrouted.cms122, true); // authored fallback exists for cms122
  assert.deepEqual(unrouted.listed, ["cms122", "cms125", "cms2", "cms130", "cms165"]);
  process.env.WORKWELL_OFFICIAL_MEASURES = "cms122,cms125,cms2,cms130,cms165";
  try {
    const routed = runProfileChild("maui", script) as { cms165: boolean };
    assert.equal(routed.cms165, true);
  } finally {
    delete process.env.WORKWELL_OFFICIAL_MEASURES;
  }
});

test("__resetRunnableMemo makes isRunnableMeasure re-read the env in-process", () => {
  const script = `
    import { isRunnableMeasure, __resetRunnableMemo } from "./src/config/deployment-profile.ts";
    const before = isRunnableMeasure("cms165");
    process.env.WORKWELL_OFFICIAL_MEASURES = "cms165";
    const memoized = isRunnableMeasure("cms165");
    __resetRunnableMemo();
    const after = isRunnableMeasure("cms165");
    console.log(JSON.stringify({ before, memoized, after }));
  `;
  const out = runProfileChild("maui", script) as { before: boolean; memoized: boolean; after: boolean };
  assert.deepEqual(out, { before: false, memoized: false, after: true });
});
```
(`runProfileChild` copies `process.env`, so setting the variable in the parent before the call is how the child sees it.)

- [ ] **Step 6: Run to verify they fail**

Run: `cd backend-ts && node --import tsx --test src/config/deployment-profile.test.ts`
Expected: FAIL — `classifyRunnable` is not exported; the Maui list still contains `hypertension`.

- [ ] **Step 7: Implement the rule**

In `backend-ts/src/config/deployment-profile.ts`, add imports and replace the validation block (lines 30–57) and the runnable exports (111–115):
```ts
import { officialMeasureIds } from "../wiring/official-routing.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { isVendoredOfficialMeasure } from "./official-measure-ids.ts";

export type RunnableKind =
  | { kind: "authored" }
  | { kind: "official" }
  | { kind: "official-pending"; reason: string }
  | { kind: "invalid"; reason: string };

/**
 * ADR-072 part 1. A measure id is runnable iff the profile lists it AND either
 *  (a) authored: registry + synthetic binding both exist; or
 *  (b) official-only: vendored + semantics recorded + named in WORKWELL_OFFICIAL_MEASURES.
 * An id that is both authored and routed is "official" (routing wins, as the router already decides).
 * Pure: `env` is passed in, never read from process.env here, so the routing flag is read at CALL time.
 */
export function classifyRunnable(id: string, env: Record<string, unknown>): RunnableKind {
  const routed = officialMeasureIds(env).has(id);
  const authored = Boolean(MEASURES[id] && MEASURE_BINDINGS[id]);
  if (routed && isVendoredOfficialMeasure(id) && officialMeasureSemantics(id)) return { kind: "official" };
  if (authored) return { kind: "authored" };
  if (!isVendoredOfficialMeasure(id)) return { kind: "invalid", reason: `${id}: not authored and not vendored under measures/official/` };
  if (!officialMeasureSemantics(id)) return { kind: "invalid", reason: `${id}: vendored but has no OFFICIAL_MEASURE_SEMANTICS entry` };
  return { kind: "official-pending", reason: `${id}: official-only and not named in WORKWELL_OFFICIAL_MEASURES on this deployment` };
}

/** Module-load validation checks only the env-independent half: every listed id must be authored OR (vendored + semantics). */
export function validateRunnableMeasureIds(ids: readonly string[]): readonly string[] {
  const invalid = ids.map((id) => classifyRunnable(id, {})).filter((k): k is { kind: "invalid"; reason: string } => k.kind === "invalid");
  if (invalid.length > 0) throw new Error(`[workwell] Invalid runnable measure id(s): ${invalid.map((k) => k.reason).join("; ")}`);
  return ids;
}

const MAUI_MEASURE_IDS = ["cms122", "cms125", "cms2", "cms130", "cms165"] as const;
```
and at the bottom:
```ts
export const RUNNABLE_MEASURE_IDS = DEPLOYMENT_PROFILE.runnableMeasureIds;

/** Lazy + memoized per (id): the routing env is read at first call, matching official-routing.ts. */
const runnableMemo = new Map<string, boolean>();
export const isRunnableMeasure = (measureId: string): boolean => {
  const memo = runnableMemo.get(measureId);
  if (memo !== undefined) return memo;
  const listed = (RUNNABLE_MEASURE_IDS as readonly string[]).includes(measureId);
  const kind = classifyRunnable(measureId, process.env as Record<string, unknown>).kind;
  const runnable = listed && (kind === "authored" || kind === "official");
  runnableMemo.set(measureId, runnable);
  return runnable;
};
/** Test seam only — clears the memo so a test can change WORKWELL_OFFICIAL_MEASURES in-process. */
export const __resetRunnableMemo = (): void => runnableMemo.clear();
```
Keep `DEFAULT_MEASURE_IDS = Object.keys(MEASURES)` unchanged (§3: default profile unchanged).

- [ ] **Step 8: Run config tests + typecheck**

Run: `cd backend-ts && corepack pnpm@10 typecheck && node --import tsx --test "src/config/*.test.ts"` → typecheck clean, `# fail 0`.
Then grep for every consumer of `isRunnableMeasure` that iterates `RUNNABLE_MEASURE_IDS` assuming all are runnable (`src/run/run-pipeline.ts` `resolveScope` EMPLOYEE/ALL_PROGRAMS/SITE, `src/run/backfill-*.ts`) and change each `RUNNABLE_MEASURE_IDS.flatMap/map(...)` to `RUNNABLE_MEASURE_IDS.filter(isRunnableMeasure).flatMap/map(...)`. Run `node --import tsx --test "src/run/*.test.ts"` → `# fail 0`.

- [ ] **Step 9: Commit (orchestrator)**

```bash
git add backend-ts/src/config/official-measure-ids.ts backend-ts/src/config/official-measure-ids.test.ts backend-ts/src/config/deployment-profile.ts backend-ts/src/config/deployment-profile.test.ts backend-ts/src/run/run-pipeline.ts backend-ts/src/run/backfill-quality-history.ts backend-ts/src/run/backfill-trend-history.ts
git commit -m "feat(config): official-only measures are runnable when vendored, gated, semantic and routed; Maui lists the five ACO measures (ADR-072)"
```

### Task 2: The subject-bundle-source seam (§4), behaviour-preserving

**Files:**
- Create: `backend-ts/src/engine/synthetic/subject-bundle-source.ts`
- Modify: `backend-ts/src/run/run-pipeline.ts:184-187` (`bundleFor`), `:215-290` (`resolveScope`), `backend-ts/src/case/case-rerun.ts:73-102`, and every RUNTIME caller listed in Step 4
- Test: `backend-ts/src/engine/synthetic/subject-bundle-source.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { bindingBundleSource, compositeBundleSource } from "./subject-bundle-source.ts";
import { EMPLOYEES } from "../../config/deployment-profile.ts";
import { seededDistribution, seededTargetFor } from "../../run/distribution.ts";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";
import { deriveExamConfig } from "./exam-config.ts";
import { buildSyntheticBundle } from "./fhir-bundle-builder.ts";

test("bindingBundleSource reproduces today's distribution, target and bundle bytes for an authored measure", () => {
  const src = bindingBundleSource();
  const e = EMPLOYEES[0]!;
  assert.deepEqual(src.distribution(EMPLOYEES, "audiogram"), seededDistribution(EMPLOYEES, MEASURE_BINDINGS.audiogram!.rateKey));
  assert.equal(src.targetFor(EMPLOYEES, "audiogram", e.externalId), seededTargetFor(EMPLOYEES, "audiogram", e.externalId));
  const target = src.targetFor(EMPLOYEES, "audiogram", e.externalId)!;
  assert.deepEqual(src.bundleFor(e, "audiogram", target, "2026-06-01"), buildSyntheticBundle(e, deriveExamConfig(MEASURE_BINDINGS.audiogram!, target), "2026-06-01"));
});

test("compositeBundleSource refuses an id it cannot classify as authored or official", () => {
  const src = compositeBundleSource({});
  assert.throws(() => src.bundleFor(EMPLOYEES[0]!, "cms137", "COMPLIANT", "2026-06-01"), /not runnable/);
});
```

- [ ] **Step 2: Run to verify it fails** — `Cannot find module './subject-bundle-source.ts'`.

- [ ] **Step 3: Implement the seam**

`backend-ts/src/engine/synthetic/subject-bundle-source.ts`:
```ts
/**
 * The seam between "who is evaluated, at which seeded bucket" and "what FHIR bundle they carry" (spec §4).
 * The run pipeline calls this and never reaches into MEASURE_BINDINGS for a bundle. `target` is the
 * seeded distribution BUCKET (exam-config.ts) — never a decision; CQL decides every outcome.
 */
import type { EmployeeProfile } from "./employee-catalog.ts";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";
import { deriveExamConfig, type TargetOutcome } from "./exam-config.ts";
import { buildSyntheticBundle, type FhirBundle } from "./fhir-bundle-builder.ts";
import { seededDistribution, seededTargetFor, type SeededAssignment } from "../../run/distribution.ts";
import { classifyRunnable } from "../../config/deployment-profile.ts";

export interface SubjectBundleSource {
  targetFor(employees: readonly EmployeeProfile[], measureId: string, subjectId: string): TargetOutcome | null;
  distribution(employees: readonly EmployeeProfile[], measureId: string): SeededAssignment[];
  bundleFor(employee: EmployeeProfile, measureId: string, target: TargetOutcome, evaluationDate: string): FhirBundle;
}

export function bindingBundleSource(): SubjectBundleSource {
  const rateKey = (id: string) => MEASURE_BINDINGS[id]!.rateKey;
  return {
    targetFor: (employees, id, subjectId) => seededTargetFor(employees, rateKey(id), subjectId),
    distribution: (employees, id) => seededDistribution(employees, rateKey(id)),
    bundleFor: (employee, id, target, evaluationDate) => buildSyntheticBundle(employee, deriveExamConfig(MEASURE_BINDINGS[id]!, target), evaluationDate),
  };
}

/** Dispatches on the runnable rule; throws for anything that is not runnable rather than guessing. */
export function compositeBundleSource(env: Record<string, unknown>, sources: { authored?: SubjectBundleSource; official?: SubjectBundleSource } = {}): SubjectBundleSource {
  const authored = sources.authored ?? bindingBundleSource();
  const pick = (id: string): SubjectBundleSource => {
    const kind = classifyRunnable(id, env);
    if (kind.kind === "official" && sources.official) return sources.official;
    if (kind.kind === "official" && MEASURE_BINDINGS[id]) return authored; // cms122/cms125: official routing over the binding-built bundle, as today
    if (kind.kind === "authored") return authored;
    throw new Error(`[workwell] ${id} is not runnable here (${kind.kind}${"reason" in kind ? `: ${kind.reason}` : ""})`);
  };
  return {
    targetFor: (employees, id, subjectId) => pick(id).targetFor(employees, id, subjectId),
    distribution: (employees, id) => pick(id).distribution(employees, id),
    bundleFor: (employee, id, target, evaluationDate) => pick(id).bundleFor(employee, id, target, evaluationDate),
  };
}
```
Note the cms122/cms125 line: today those two are official-routed but their bundles come from the binding builder (the dual-stamped shapes). Task 3 adds `sources.official` for cms2/cms130/cms165 only; the composite prefers it when present **and** the id has no binding — implement that precedence as: `if (kind.kind === "official") return MEASURE_BINDINGS[id] ? authored : sources.official ?? throwNoShape(id)`.

- [ ] **Step 4: Wire the pipeline**

In `run-pipeline.ts`: add `bundleSource?: SubjectBundleSource` to `RunPipelineDeps` with default `compositeBundleSource(process.env as Record<string, unknown>)` resolved once at the top of `planManualRun`/the evaluation entry (one `const source = deps.bundleSource ?? defaultBundleSource()`), then:
- `bundleFor(item, liveRoster, evalDate, source)` → `source.bundleFor(item.employee, item.measureId, item.target!, evalDate)` in the synthetic branch;
- in `resolveScope`, replace every `seededDistribution(employees, MEASURE_BINDINGS[measureId]!.rateKey)` with `source.distribution(employees, measureId)` and `seededTargetFor(employees, MEASURE_BINDINGS[measureId]!.rateKey, id)` with `source.targetFor(employees, measureId, id)`; `resolveScope` gains a `source` parameter.
- `case-rerun.ts:75`: replace the `binding` existence check with `isRunnableMeasure(existing.measureId)` alone and build the bundle through the source.
- **Every other RUNTIME path that builds a synthetic bundle or reads a binding's `rateKey` goes through the source too** (spec-review finding): `routes/compliance-api.ts:384-400` (the per-subject evaluate path), `run/employee-compliance-snapshot.ts:60-66`, `measure/impact-preview.ts:149-169`, `run/backfill-quality-history.ts:132,156-162`, `run/backfill-trend-history.ts` (its `RUNNABLE_MEASURE_IDS` loops). Each replaces `deriveExamConfig(MEASURE_BINDINGS[id]!, target)` + `buildSyntheticBundle(...)` with `source.bundleFor(...)` and `MEASURE_BINDINGS[id]!.rateKey` with `source.targetFor/distribution`.
- **Deliberately NOT routed through the seam, and stated in a comment at each site:** the scale/seed CLIs (`run/scale-generator.ts:46-51`, `run/batch-evaluate-scale.ts:232-236`, `run/backfill-scale.ts:94-97`) and the diagnostic harnesses (`standards/execution-diff.ts:113-123`, `standards/literal-diff.ts:248-264`). They are authored-measure seeds/diagnostics that already filter on `MEASURE_BINDINGS[id]` and so never see an official-only id; keeping them on the binding builder keeps their fixtures byte-identical.
Remove the now-unused `MEASURE_BINDINGS` / `deriveExamConfig` / `buildSyntheticBundle` imports from `run-pipeline.ts` if nothing else uses them.

- [ ] **Step 5: Run the run + case + golden tests**

Run: `cd backend-ts && corepack pnpm@10 typecheck && node --import tsx --test "src/run/*.test.ts" "src/case/*.test.ts" "src/engine/synthetic/*.test.ts"` → `# fail 0`. The goldens (`fhir-bundle-builder.test.ts`, `official-corpus-outcomes.test.ts`) must be byte-identical: this task changes no output.

- [ ] **Step 6: Commit** — `git add` the four files → `refactor(run): the pipeline takes its subject bundles from a SubjectBundleSource seam (no behaviour change)`.

### Task 3: The three official-only bundle shapes (§4.1)

**Files:**
- Create: `backend-ts/src/engine/synthetic/official-only-bundles.ts`
- Modify: `backend-ts/src/engine/synthetic/subject-bundle-source.ts` (export `officialOnlyBundleSource`, wire into composite default), `backend-ts/src/engine/cql/bundled-ecqm-expansions.ts` (add the canonical codes the shapes stamp), `backend-ts/src/wiring/corpus-membership.test.ts:33-45` (add cms2/cms130/cms165 to the artifact list), `backend-ts/src/wiring/official-corpus-outcomes.test.ts` (three new cases)
- Test: `backend-ts/src/engine/synthetic/official-only-bundles.test.ts` (create)

**Before writing any code, the lane MUST read each artifact's ELM for the exact value-set OIDs and codes** (`backend-ts/measures/official/{cms2,cms130,cms165}/bundle.json`, the `Library` resource's `relatedArtifact`/`dataRequirement` entries and the ValueSet resources) and the terminology sidecar (`terminology.json` in the same dirs, present after `pnpm vendor:official`; if absent, `bundled-ecqm-expansions.ts`'s existing pattern of pinning one known member per OID is the fallback and the lane reports which OIDs it pinned from the sidecar and which from the CMS value-set pages). The table in spec §4.1 is the contract; **the ELM wins on any disagreement, and the lane corrects the spec table in the same change.**

- [ ] **Step 1: Write the failing convergence test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildOfficialOnlyBundle, OFFICIAL_ONLY_CONVERGENCE } from "./official-only-bundles.ts";
import { EMPLOYEES } from "../../config/deployment-profile.ts";

const EVAL = "2027-06-30";
const e = EMPLOYEES.find((x) => x.tenantId === "maui")!;

test("every (measure, target) pair yields a collection bundle with a QI-Core Patient and an office visit", () => {
  for (const id of ["cms2", "cms130", "cms165"] as const) {
    for (const target of ["COMPLIANT", "OVERDUE", "EXCLUDED", "MISSING_DATA", "DUE_SOON"] as const) {
      const b = buildOfficialOnlyBundle(e, id, target, EVAL);
      assert.equal(b.type, "collection");
      const types = b.entry.map((x) => (x.resource as { resourceType: string }).resourceType);
      assert.ok(types.includes("Patient") && types.includes("Encounter"), `${id}/${target}: ${types.join(",")}`);
    }
  }
});

// Documentation-only assertion (it pins a constant the implementer wrote). The REAL check is Step 4's
// executor test, which feeds these bundles through the official artifact and asserts the mapping.
test("the convergence table is declared: DUE_SOON and MISSING_DATA converge to OVERDUE for all three", () => {
  for (const id of ["cms2", "cms130", "cms165"] as const) {
    assert.equal(OFFICIAL_ONLY_CONVERGENCE[id].DUE_SOON, "OVERDUE");
    assert.equal(OFFICIAL_ONLY_CONVERGENCE[id].MISSING_DATA, "OVERDUE");
  }
});

test("cms165 COMPLIANT carries one BP panel with systolic 128 and diastolic 78 inside the measurement period", () => {
  const b = buildOfficialOnlyBundle(e, "cms165", "COMPLIANT", EVAL);
  const obs = b.entry.map((x) => x.resource as Record<string, unknown>).find((r) => r.resourceType === "Observation")!;
  const comps = obs.component as Array<{ code: { coding: Array<{ code: string }> }; valueQuantity: { value: number } }>;
  assert.deepEqual(comps.map((c) => [c.code.coding[0]!.code, c.valueQuantity.value]), [["8480-6", 128], ["8462-4", 78]]);
  assert.ok(String(obs.effectiveDateTime).startsWith("2027-"));
});

test("cms2 COMPLIANT (adult) uses the adult screening instrument and a negative result", () => {
  const b = buildOfficialOnlyBundle(e, "cms2", "COMPLIANT", EVAL);
  const obs = b.entry.map((x) => x.resource as Record<string, unknown>).find((r) => r.resourceType === "Observation")!;
  const codes = (obs.code as { coding: Array<{ code: string }> }).coding.map((c) => c.code);
  assert.ok(codes.includes("73832-8"), codes.join(","));
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement the shapes**

`backend-ts/src/engine/synthetic/official-only-bundles.ts` — structure (the lane fills every code from the artifact; the skeleton is binding):
```ts
import type { EmployeeProfile } from "./employee-catalog.ts";
import type { TargetOutcome } from "./exam-config.ts";
import type { FhirBundle } from "./fhir-bundle-builder.ts";
import { ECQM_CANONICAL_CODES } from "../cql/bundled-ecqm-expansions.ts";

export type OfficialOnlyMeasureId = "cms2" | "cms130" | "cms165";
export const OFFICIAL_ONLY_MEASURE_IDS: readonly OfficialOnlyMeasureId[] = ["cms2", "cms130", "cms165"];

/** What CQL is expected to say for each seeded bucket — pinned so a drift is a test failure, not a surprise. */
export const OFFICIAL_ONLY_CONVERGENCE: Record<OfficialOnlyMeasureId, Record<TargetOutcome, "COMPLIANT" | "OVERDUE" | "EXCLUDED">> = {
  cms2:   { COMPLIANT: "COMPLIANT", OVERDUE: "OVERDUE", EXCLUDED: "EXCLUDED", MISSING_DATA: "OVERDUE", DUE_SOON: "OVERDUE" },
  cms130: { COMPLIANT: "COMPLIANT", OVERDUE: "OVERDUE", EXCLUDED: "EXCLUDED", MISSING_DATA: "OVERDUE", DUE_SOON: "OVERDUE" },
  cms165: { COMPLIANT: "COMPLIANT", OVERDUE: "OVERDUE", EXCLUDED: "EXCLUDED", MISSING_DATA: "OVERDUE", DUE_SOON: "OVERDUE" },
};

const QICORE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";
const LOINC = "http://loinc.org";
const SNOMED = "http://snomed.info/sct";

function patient(e: EmployeeProfile, birthDate: string, extra: Record<string, unknown> = {}) { /* Patient with meta.profile qicore-patient, id e.externalId, name, birthDate, ...extra */ }
function encounter(e: EmployeeProfile, day: string) { /* finished AMB Encounter, type = ECQM_CANONICAL_CODES.officeVisit, period day 09:00–09:30 */ }
function condition(e: EmployeeProfile, id: string, codings: Array<{system: string; code: string; display?: string}>, onset: string) { /* active/confirmed qicore-condition */ }
function inPeriod(evaluationDate: string, daysBeforeEval: number): string { /* clamps to >= YYYY-01-01 of the evaluation year */ }

export function buildOfficialOnlyBundle(e: EmployeeProfile, id: OfficialOnlyMeasureId, target: TargetOutcome, evaluationDate: string): FhirBundle {
  switch (id) {
    case "cms2":   return cms2(e, target, evaluationDate);
    case "cms130": return cms130(e, target, evaluationDate);
    case "cms165": return cms165(e, target, evaluationDate);
  }
}
// cms2: birthDate → age 40 at period end; Observation code = LOINC 73832-8 (adult instrument, from the artifact's
//   "Adult Depression Screening Assessment" set) with valueCodeableConcept from the artifact's NEGATIVE set
//   (COMPLIANT/EXCLUDED) or POSITIVE set (OVERDUE), effective on the encounter day; EXCLUDED adds Condition
//   from the bipolar-disorder set; OVERDUE has no follow-up; MISSING_DATA/DUE_SOON: no Observation.
// cms130: birthDate → age 60 at period end; COMPLIANT = Procedure (colonoscopy set member) performed 3y before;
//   EXCLUDED = Condition colorectal cancer set member; OVERDUE/MISSING/DUE_SOON: no screening.
// cms165: birthDate → age 55; Condition essential hypertension set member with onset 2y before period start
//   (every target); COMPLIANT = Observation 85354-9 with components 8480-6=128 / 8462-4=78 dated inPeriod(eval, 60);
//   OVERDUE = same with 152/94; EXCLUDED = Condition from the ESRD set + the 128/78 reading;
//   MISSING_DATA/DUE_SOON: no Observation.
```
Every clinical code is emitted as **two codings**: the artifact's own member (system + code from the sidecar/ELM) and, where the roster's authored path expects one, the `urn:workwell:*` legacy coding — the same dual-stamping `fhir-bundle-builder.ts` does. Add each new canonical code to `ECQM_CANONICAL_CODES` + `CANONICAL_CODE_VALUE_SETS` in `bundled-ecqm-expansions.ts` (keys: `depressionScreenAdult`, `depressionScreenAdolescent`, `depressionScreenNegative`, `depressionScreenPositive`, `bipolarDisorder`, `colonoscopy`, `colorectalCancer`, `essentialHypertension`, `bpPanel`, `esrd`) so `corpus-membership.test.ts` covers them.

Then export from `subject-bundle-source.ts`:
```ts
export function officialOnlyBundleSource(): SubjectBundleSource {
  return {
    targetFor: (employees, id, subjectId) => seededTargetFor(employees, id, subjectId),
    distribution: (employees, id) => seededDistribution(employees, id),
    bundleFor: (employee, id, target, evaluationDate) => buildOfficialOnlyBundle(employee, id as OfficialOnlyMeasureId, target, evaluationDate),
  };
}
```
and make `compositeBundleSource`'s default `sources.official = officialOnlyBundleSource()`.

- [ ] **Step 4: Extend the invariant tests**

`corpus-membership.test.ts:35`: `for (const catalogId of ["cms122", "cms125", "cms2", "cms130", "cms165"])`. `official-corpus-outcomes.test.ts`: add, for each of the three ids, a case that evaluates all 48 Maui patients (`EMPLOYEES.filter(e => e.tenantId === "maui")`) through `officialMeasureExecutor` over `evaluationDate = "2027-06-30"` with the shapes at their seeded targets and asserts (a) `inInitialPopulation === true` for every subject (each shape sets an in-range age and an in-period visit), (b) the outcome equals `OFFICIAL_ONLY_CONVERGENCE[id][target]` for every subject. This test self-skips without the terminology sidecar exactly as the existing cms122/cms125 cases do (copy their `skip` predicate).

- [ ] **Step 5: Run** — `node --import tsx --test src/engine/synthetic/official-only-bundles.test.ts src/wiring/corpus-membership.test.ts src/wiring/official-corpus-outcomes.test.ts` → `# fail 0` (report skips honestly if the sidecar is absent; the orchestrator runs the sidecar-present gate).

- [ ] **Step 6: Commit** — `feat(synthetic): QI-Core bundle shapes for cms2, cms130, cms165 — the official-only measures get a corpus (MM-1b)`.

### Task 4: Calendar-year measurement period + the effectivePeriod warning (§5)

**Files:**
- Modify: `backend-ts/src/wiring/official-executor-adapter.ts:287-298` (`officialMeasurementPeriod`), `:519-549` (evidence block), `backend-ts/src/run/run-pipeline.ts:335-342` (`planManualRun`), `backend-ts/src/run/compliance-period.ts:56-59`, `backend-ts/src/worker.ts:381-403` (`logSeamInventoryOnce`)
- Test: `backend-ts/src/wiring/official-executor-adapter.test.ts` (extend), `backend-ts/src/run/compliance-period.test.ts` (extend or create), `backend-ts/src/run/run-pipeline.test.ts` (extend)

- [ ] **Step 1: Failing tests**

```ts
// official-executor-adapter.test.ts
test("officialMeasurementPeriod is the calendar year containing the evaluation date (ADR-072)", () => {
  assert.deepEqual(officialMeasurementPeriod("cms165", "2027-06-30"), { start: "2027-01-01", end: normalizePeriodEnd("2027-12-31") });
  assert.deepEqual(officialMeasurementPeriod("cms122", "2027-01-01").start, "2027-01-01");
  assert.deepEqual(officialMeasurementPeriod("cms122", "2027-12-31").start, "2027-01-01");
});
test("effectivePeriodWarning names the measure, the artifact period and the run period when they do not overlap", () => {
  const artifact = loadOfficialArtifact("cms165")!; // manifest.effectivePeriod 2026-01-01..2026-12-31
  assert.match(effectivePeriodWarning(artifact, { start: "2027-01-01", end: "2027-12-31T23:59:59.999Z" })!, /cms165.*2026-01-01.*2027-01-01/s);
  assert.equal(effectivePeriodWarning(artifact, { start: "2026-01-01", end: "2026-12-31T23:59:59.999Z" }), null);
});
// compliance-period.test.ts
test("an official-only measure buckets to the calendar year explicitly, not by the 365-day fallback", () => {
  assert.equal(bucketPeriodForMeasure("cms165", "2027-08-15"), "2027-01-01");
  assert.equal(bucketPeriodForMeasure("cms2", "2027-02-01"), "2027-01-01");
});
// run-pipeline.test.ts — planManualRun with a MEASURE scope of an official-routed id records the calendar year
test("a run whose every measure is official-routed records the calendar-year period on the run row", async () => {
  process.env.WORKWELL_OFFICIAL_MEASURES = "cms122";
  try {
    const planned = await planManualRun(deps, { scopeType: "MEASURE", measureId: "cms122", evaluationDate: "2027-06-30" });
    assert.equal(planned.run.measurementPeriodStart, "2027-01-01T00:00:00.000Z");
    assert.equal(planned.run.measurementPeriodEnd, "2027-12-31T23:59:59.999Z");
  } finally { delete process.env.WORKWELL_OFFICIAL_MEASURES; }
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`official-executor-adapter.ts`:
```ts
export function officialMeasurementPeriod(_measureId: string, evaluationDate: string): { start: string; end: string } {
  // ADR-072: an eCQM is defined on a calendar measurement period. The rolling registry window is the
  // AUTHORED path's; the official path uses the calendar year containing the evaluation date.
  const year = evaluationDate.slice(0, 4);
  return { start: `${year}-01-01`, end: normalizePeriodEnd(`${year}-12-31`) };
}
export function effectivePeriodWarning(artifact: OfficialArtifact, period: { start: string; end: string }): string | null {
  const ep = artifact.manifest.effectivePeriod;
  if (!ep?.start || !ep?.end) return null;
  const covered = ep.start.slice(0, 10) <= period.start.slice(0, 10) && ep.end.slice(0, 10) >= period.end.slice(0, 10);
  return covered ? null :
    `${artifact.manifest.catalogId}: the vendored artifact declares effectivePeriod ${ep.start}..${ep.end} but this run's measurement period is ${period.start.slice(0, 10)}..${period.end.slice(0, 10)} — the logic is a prior-year vintage (ROADMAP MM-1d); re-vendor when CMS publishes the FHIR content for this year.`;
}
```
In the evidence block add `measurementPeriod: period` inside `official: {…}` (the `period` const already exists at :446 — pass it down to where the outcomes are built). In `evaluateBatch`, after computing `period`, `const warn = effectivePeriodWarning(artifact, period); if (warn) console.warn(\`[workwell] ${warn}\`);` and expose it: add an optional `onWarning?: (message: string) => void` to `OfficialExecutorDeps`, called instead of `console.warn` when provided; the run pipeline passes `(m) => deps.runStore.appendLog(run.id, "WARN", m)` so the warning lands on the run.

`compliance-period.ts`:
```ts
import { isVendoredOfficialMeasure } from "../config/official-measure-ids.ts";
export function bucketPeriodForMeasure(measureId: string, asOf: string): string {
  // ADR-072: official-only measures bucket to the calendar year by rule, not by the 365-day fallback.
  if (!MEASURE_BINDINGS[measureId] && isVendoredOfficialMeasure(measureId)) return cycleAnchor("ANNUAL", asOf);
  const window = MEASURE_BINDINGS[measureId]?.complianceWindowDays ?? 365;
  return cycleKey(window, SEASONAL_MEASURE_IDS.has(measureId), asOf);
}
```

`run-pipeline.ts` `planManualRun`: after `resolveScope`, compute
```ts
const allOfficial = measureIds.length > 0 && measureIds.every((id) => isOfficialRouted(id));
const period = allOfficial
  ? { start: `${evalDate.slice(0, 4)}-01-01T00:00:00.000Z`, end: `${evalDate.slice(0, 4)}-12-31T23:59:59.999Z` }
  : { start: new Date(new Date(periodEnd).getTime() - 365 * 86400000).toISOString(), end: periodEnd };
```
and pass `measurementPeriodStart: period.start, measurementPeriodEnd: period.end`.

**Every reader of `run.measurementPeriodStart/End` and every place that fabricates a period, enumerated (spec-review finding 4):** `fhir/measure-report.ts:425,459`, `fhir/qrda1-export.ts:253-254`, `fhir/qrda3-export.ts:173-174`, `routes/runs.ts:555-556` READ the run row and need no change; the rule above makes the row right for an all-official run. `case/case-rerun.ts:91-92` fabricates the rolling window for a single-measure rerun: it must use the same rule (an official-routed measure => calendar year) via one shared helper `runMeasurementPeriod(measureIds, evalDate)` exported from a new `run/run-period.ts` that `planManualRun` also calls. The scale/trend/quality backfills (`batch-evaluate-scale.ts:232-233`, `backfill-scale.ts:94-95`, `backfill-trend-history.ts:220-221`) keep their rolling windows: they seed AUTHORED measures only (they filter on `MEASURE_BINDINGS`), and a one-line comment at each site says so.

`worker.ts` `logSeamInventoryOnce` (re-confirm the line range before editing; ~`:381-403`): after the routing problems, for each id in `officialMeasureIds(env)` load the artifact and print `effectivePeriodWarning(artifact, officialMeasurementPeriod(id, today))` if non-null with `console.warn`; also print `[workwell] runnable=${RUNNABLE_MEASURE_IDS.map(id => \`${id}:${classifyRunnable(id, env).kind}\`).join(",")}` (the §3 boot line).

- [ ] **Step 4: Run** — `corepack pnpm@10 typecheck && node --import tsx --test "src/wiring/*.test.ts" "src/run/*.test.ts" "src/fhir/*.test.ts"` → `# fail 0`. If a MeasureReport/QRDA test pinned the rolling window for an official run, update the pin to the calendar year and say so.

- [ ] **Step 5: Commit** — `feat(engine): official measures evaluate over the calendar year; the run and evidence say which period, and a stale effectivePeriod warns (ADR-072)`.

### Task 5: Catalog activation + seed promotion (§6)

**Files:**
- Modify: `backend-ts/src/measure/measure-catalog.ts` (rows `cms2`, `cms130`, `cms165`), `backend-ts/src/measure/measure-seed.ts:52-78, 111-153, 162+`
- Test: `backend-ts/src/measure/measure-seed.test.ts` (extend)

- [ ] **Step 1: Failing tests**

```ts
test("matchesSeedFingerprint is exported and true only for an untouched seeded row", async () => { /* seed a fresh store, read cms165, expect true; updateSpec(...) then expect false */ });
test("seedMeasureStore promotes an untouched Draft cms2/cms130/cms165 row to Active and writes MEASURE_ACTIVATED once", async () => {
  // 1) seed with a catalog where the three are Draft (simulate the pre-change store by seeding, then setVersionStatus back to Draft with the seed timestamps)
  // 2) run seedMeasureStore again → status Active; one MEASURE_ACTIVATED audit per id; running a third time writes no second event (hasAuditEvent guard)
});
test("an edited Draft row is not promoted and a warning names it", async () => { /* updateSpec on cms165 then seed → still Draft; console.warn captured */ });
```

- [ ] **Step 2: Fail.** — `matchesSeedFingerprint` not exported; rows still Draft.

- [ ] **Step 3: Implement**

Catalog rows (replace the three entries):
```ts
{"id":"cms2","name":"Preventive Care and Screening: Screening for Depression and Follow-Up Plan","policyRef":"CMS2v15","version":"v1.0","status":"Active","owner":"WorkWell Studio","tags":["ecqm","cms","mental-health","preventive"],"compileStatus":"COMPILED","spec":{"description":"Screening for Depression and Follow-Up Plan (CMS2v15 / MIPS 134): patients 12+ screened for depression with an age-appropriate standardized tool during the measurement period and, if positive, with a follow-up plan documented on the date of the positive screen. Evaluated by CMS's published QI-Core artifact (2026 FHIR content) over the calendar measurement period.","eligibilityCriteria":{"roleFilter":"All","siteFilter":"All Sites","programEnrollmentText":"Age 12+ with a qualifying encounter"},"exclusions":[{"label":"Bipolar disorder","criteriaText":"Active bipolar disorder diagnosis (denominator exclusion)"},{"label":"Exception","criteriaText":"Patient refusal or medical reason (denominator exception)"}],"complianceWindow":"Calendar measurement period","requiredDataElements":["Depression screening result","Follow-up plan (if positive)","Encounter"],"testFixtures":[]}},
```
and analogous rows for cms130 (MIPS 113; ages 46–75 at period end; exclusions colorectal cancer / total colectomy; data elements: screening procedure or result with date) and cms165 (MIPS 236; ages 18–85 with essential hypertension; exclusions ESRD/dialysis/transplant, pregnancy, hospice, frailty+advanced illness 66+; data elements: BP reading).

`measure-seed.ts`: extract
```ts
export function matchesSeedFingerprint(row: MeasureRecord, catalog: CatalogMeasure, expectedStatus?: string): boolean { /* body of isUnmodifiedLegacySeed, generalized: name, policyRef, spec JSON, createdAt === TIER[catalog.status], status === expectedStatus ?? catalog.status */ }
```
Make `isUnmodifiedLegacySeed` and `repairHypertensionSeedRow` call it. Add:
```ts
const PROMOTED_OFFICIAL_ONLY = ["cms2", "cms130", "cms165"] as const;
async function promoteOfficialOnlyRows(store: MeasureStore, events: CaseEventStore): Promise<void> {
  for (const id of PROMOTED_OFFICIAL_ONLY) {
    const catalog = MEASURE_CATALOG.find((m) => m.id === id)!;
    const row = await store.getLatest(id);
    if (!row || row.status === "Active") continue;
    if (!matchesSeedFingerprint(row, catalog, "Draft")) { console.warn(`[measure-seed] ${id} row was edited; not promoted to Active`); continue; }
    await store.setVersionStatus(id, row.versionId, { status: "Active", activate: true });
    const audit = { eventType: "MEASURE_ACTIVATED", entityType: "measure_version", entityId: row.versionId, actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: row.versionId,
      payload: { measureId: id, version: row.version, reason: "official-only measure activated (MM-1b, ADR-072)", activatedBy: "system" } };
    if (!(await events.hasAuditEvent(audit))) await events.appendAudit(audit);
  }
}
```
called from `seedMeasureStore` after `deprecateLegacyOfficialRows`.

- [ ] **Step 4: Run** — `node --import tsx --test "src/measure/*.test.ts" "src/routes/measures.test.ts" "src/routes/programs.test.ts"` → `# fail 0` (the programs overview test "one row per Active measure (the runnable set)" may need its expected count updated on the default profile — Active but not runnable there; verify it filters by `isRunnableMeasure`, which it does at `program-read-models.ts:257`).

- [ ] **Step 5: Commit** — `feat(measure): cms2, cms130, cms165 are Active; the seed promotes an untouched Draft row once, audited (MM-1b)`.

### Task 6: Vendored MADiE test cases with provenance (§9)

**Files:**
- Modify: `backend-ts/scripts/vendor-official-measure.mjs` (add `--with-tests`: copy `input/tests/measure/<Name>/` from the pinned checkout into `measures/official/<id>/tests/`, write `manifest.tests = { count, sourcePath, sha256 }`), `backend-ts/src/standards/official-cases.ts:342-360` (prefer `measures/official/<id>/tests` when present), `backend-ts/src/wiring/official-artifacts.ts` (`OfficialManifest.tests?`)
- Test: `backend-ts/scripts/vendor-official-measure.test.mjs` (extend), `backend-ts/src/standards/official-cases.test.ts` (extend)

- [ ] **Step 1: Failing test** — `loadOfficialMeasureCases` with a content dir that lacks the tests but a vendored `measures/official/cms2/tests/` present loads the vendored cases; the manifest `tests.sha256` equals the SHA-256 of the sorted, concatenated case files; a corrupted file fails the hash check with a message naming the file.

- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement** the copy in the vendor script (sorted file walk, `crypto.createHash("sha256")` over `relativePath + "\n" + bytes` per file), the manifest field, and the reader preference (`const vendoredTests = join(OFFICIAL_ROOT, measure, "tests"); if (existsSync(vendoredTests)) { verifyTestsHash(...); testsDir = vendoredTests; }`). Then run `pnpm vendor:official --measure <each of five> --tests-only` locally from `.official-content` (no VSAC key needed; the flag short-circuits before the bundle/terminology/manifest writes at `vendor-official-measure.mjs:446-477` and touches only `tests/` plus the manifest's `tests` block) and commit the five `tests/` directories (measured < 3 MB).
- [ ] **Step 3b: the CI reproducibility gate (spec-review findings 8-9).** `ci.yml`'s `official-cases` job re-vendors and runs `git diff --exit-code measures/official`. Two changes, orchestrator-owned because they are workflow edits: (1) the re-vendor step passes `--with-tests` so the regenerated manifest carries the same `tests` block and the gate stays green; (2) the check becomes `git status --porcelain -- backend-ts/measures/official` (empty output required), because `git diff` ignores untracked files and a regenerated-but-untracked `tests/` file would pass silently. A test in `scripts/vendor-official-measure.test.mjs` pins that a `--with-tests` run on an already-vendored measure is byte-idempotent.

- [ ] **Step 4: Run** — `corepack pnpm@10 test:official-cases` (with `--allow-missing-terminology` if the sidecar is absent) → still 410/410, now reading vendored cases for the five.

- [ ] **Step 5: Commit** — `feat(standards): the five pilot measures' MADiE cases are vendored with a hash, and the gate reads them from the tree`.

### Task 7: Docs + ADR-072 (PR 1 half)

**Files:** `docs/DECISIONS.md` (ADR-072 body, newest-first), `docs/ADR_INDEX.md` (title line), `docs/MEASURES.md` (five rows + period + effectivePeriod note + v15 delta note), `docs/DEPLOY.md` (Maui: runnable set, `WORKWELL_OFFICIAL_MEASURES` list, activation prerequisite), `docs/DATA_MODEL_CONTRACTS.md` §5 (two sentences: run-level vs outcome-level period), `docs/guide/03-*.md` (engine chapter: runnable rule + period), `docs/guide/09-*.md` (numbers, dated), `docs/LOCKED_DECISIONS.md` §4A.2 (SINCE note: D1), `docs/JOURNAL.md` (entry).

- [ ] Write ADR-072 with the title `official-only measures are runnable when vendored, gated, semantic and routed — and an eCQM runs over its calendar year, not a rolling window`, sections Context / Decision (the rule, the period, D1, D2) / Alternatives rejected (importing the gate module into config; keeping the rolling window; MM-1a's confirm-first for 305) / Consequences (default profile unchanged; TWH cms122/cms125 period change; re-vendor trigger).
- [ ] Regenerate the index line: `grep -o '^#\+ ADR-[0-9]*.*' docs/DECISIONS.md` → paste the ADR-072 line at the top of `ADR_INDEX.md`.
- [ ] Commit — `docs: ADR-072, MEASURES/DEPLOY/guide for the five Maui measures and the calendar period`.

**PR 1 gate (orchestrator):** `cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test > gate.log 2>&1; echo EXIT=$?` and `grep -E '^# (pass|fail)' gate.log`; `corepack pnpm@10 test:official-cases`; three reviews (external CLI, own reviewer, PR bot).

---

## PR 2 — `feat/mm1-official-surfaces-flip-gate` (Tasks 8–11; branches from PR 1)

### Task 8: The official display table (§6)

**Files:**
- Create: `backend-ts/src/compliance/official-display.ts`
- Modify: `backend-ts/src/compliance/roster-vocabulary.ts:20-70` (`deriveCell`), `backend-ts/src/case/case-logic.ts:75-93` (`NEXT_ACTION_OVERRIDES` → read the table), `backend-ts/src/case/case-detail-read-model.ts:93+` (`deriveWhyFlagged` gains `official_summary` when routed)
- Test: `backend-ts/src/compliance/official-display.test.ts` (create), extend `roster-vocabulary.test.ts`, `case-logic.test.ts`

- [ ] **Step 1: Failing exhaustiveness test**
```ts
import { OFFICIAL_DISPLAY, officialDisplayFor } from "./official-display.ts";
const IDS = ["cms122", "cms125", "cms2", "cms130", "cms165"] as const;
const STATUSES = ["COMPLIANT", "OVERDUE", "EXCLUDED", "MISSING_DATA"] as const;
test("every (measure, status) pair has status wording, a why line and a next action", () => {
  for (const id of IDS) for (const s of STATUSES) {
    const d = officialDisplayFor(id, s)!;
    assert.ok(d.method && d.whyFlagged && d.nextAction, `${id}/${s}`);
    assert.doesNotMatch(d.method, /on file/i); // official wording never claims a record's absence for OVERDUE
  }
});
test("cms122 OVERDUE says what the numerator means, not 'no record'", () => {
  assert.match(officialDisplayFor("cms122", "OVERDUE")!.method, /above 9%/);
});
test("EXCLUDED is a denominator exclusion or exception, never an 'exemption on file'", () => {
  for (const id of IDS) assert.match(officialDisplayFor(id, "EXCLUDED")!.method, /excluded by measure logic/i);
});
```
- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement** `OFFICIAL_DISPLAY: Record<string, Record<string, { method: string; whyFlagged: string; nextAction: string }>>` with the five measures' wording (cms2 OVERDUE: "No depression screening this period, or a positive screen without a follow-up plan"; cms130 OVERDUE: "No colorectal cancer screening within the accepted interval"; cms165 OVERDUE: "Most recent blood pressure this period at or above 140/90"; cms125 OVERDUE: "No mammogram in the 27-month window"; MISSING_DATA for all: "Not in the measure's initial population for this period, or no qualifying encounter"; EXCLUDED for all: "Excluded by measure logic (denominator exclusion or exception)"; COMPLIANT per numerator). `deriveCell`: `if (isOfficialRouted(measureId)) { const d = officialDisplayFor(measureId, canonicalStatus); if (d) return { status: canonicalStatus as DisplayState, method: d.method }; }` before the existing branches. `nextActionFor`: consult `officialDisplayFor(measureId, outcomeStatus)?.nextAction` first when routed, then the existing overrides. `deriveWhyFlagged`: add `official_summary: d.whyFlagged` when routed. Authored measures: byte-identical (pin with the existing tests).
- [ ] **Step 4: Run** `node --import tsx --test "src/compliance/*.test.ts" "src/case/*.test.ts" "src/cds/*.test.ts"` → `# fail 0`; the CDS card tests must show the new wording flows through `deriveCell`/`nextActionFor` with no card-side text.
- [ ] **Step 5: Commit** — `feat(compliance): official measures get wording that says what the numerator means (roster, case, card)`.

### Task 9: `routing` on the measure read model + frontend badge (§6)

**Files:** `backend-ts/src/measure/measure-read-models.ts:12-50` (`routing: "authored" | "official" | "official-pending"` computed via `classifyRunnable(r.measureId, process.env)`), `backend-ts/src/routes/measures.ts:186-190` (no change if `toMeasure` carries it), `frontend/app/(dashboard)/measures/page.tsx` (the local `type Measure` at `:16` gains `routing`; the list renders the badge "Official" / "Official · not yet routed here"; there is no `[id]/page.tsx`, so measure detail is out of scope), tests in `frontend/app/(dashboard)/measures/__tests__/` (copy the MSW mocking template from `compliance/__tests__/page.test.tsx`).

- [ ] Backend failing test → implement → `node --import tsx --test src/measure/measure-read-models.test.ts src/routes/measures.test.ts`.
- [ ] Frontend failing test (renders the badge for `routing: "official-pending"`, no badge for `authored`) → implement → `cd frontend && corepack pnpm@10 lint && corepack pnpm@10 test && corepack pnpm@10 build`.
- [ ] Commit — `feat(measure): the measure list says whether a measure runs its official artifact here`.

### Task 10: The `official-flip-gate` CLI (§8)

**Files:**
- Create: `backend-ts/src/run/cli/official-flip-gate.ts`, `backend-ts/src/run/cli/official-flip-gate-bin.ts`, `backend-ts/src/run/cli/official-flip-gate.test.ts`
- Modify: `backend-ts/package.json` (`"flip-gate": "tsx src/run/cli/official-flip-gate-bin.ts"`), repo `.gitignore` (`/backend-ts/.flip-gate/`)

- [ ] **Step 1: Failing test** — `gateMeasure("cms165", subjects, "2027-06-30")` over the 48 Maui synthetic subjects (built through `officialOnlyBundleSource`) returns `{ measureId, madie: { pass, fail, total }, roster: { subjects, inIpp, denominator, distribution, evaluationErrors }, effectivePeriod: { covered: false, warning } , verdictText }`; `renderGate` prints the ADR-043 sentence when `inIpp === 0`; `parseArgs(["--measure","cms2"])` defaults `evaluationDate` to today (UTC `YYYY-MM-DD`).
- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement.** `src/run/cli/official-cases.ts` exports only `main()`, `parseArgs`, `exitCodeForRuns`; the per-measure loop is inline in `main` (:314-370). First extract it, behaviour-preserving, into an exported `runOfficialMeasure(id: OfficialMeasureId, contentDir: string, opts): MeasureRunResult` that `main` calls in its loop (the existing `official-cases.test.ts` must stay green byte-for-byte on the report). Then the gate reuses `runOfficialMeasure` for (1), `officialMeasureExecutor` + `evaluateLikeTheRunPipeline` from `official-flip-snapshot.ts` for (2), `effectivePeriodWarning` for (3); write `backend-ts/.flip-gate/<id>-<date>.json` via `mkdirSync({recursive:true})` + `writeFileSync`. Descriptive only: exit code 0 always; the verdict block is text.
- [ ] **Step 4: Run** `node --import tsx --test src/run/cli/official-flip-gate.test.ts` and a smoke `corepack pnpm@10 flip-gate --measure cms165 --evaluation-date 2027-06-30` (WORKWELL_INSTANCE=maui) → report printed, JSON written.
- [ ] **Step 5: Commit** — `feat(cli): official-flip-gate — the flip-snapshot successor for measures with no authored counterpart`.

### Task 11: PR 2 docs

`docs/CDS_HOOKS.md` (card text now comes from the official display table when routed; still no AI, no systemActions, no critical), `docs/guide/` chapter that describes roster wording, `docs/DEPLOY.md` (flip runbook: `pnpm flip-gate` before each workflow edit; edit BOTH `deploy-maui-mieweb.yml` and `reconcile-maui-mieweb.yml`), `docs/JOURNAL.md`. Commit — `docs: flip runbook, card wording source, guide`.

---

## PR 3 — MM-1c verification and flips (Tasks 12–14)

### Task 12: CMS2 — the seven second-engine disagreements (investigation lane, timebox 1 day)

**Deliverable:** a finding in `docs/JOURNAL.md` and `backend-ts/spike/cms2-second-engine/README.md` (gitignored path is NOT used — the finding is repo history), no product code.
- [ ] Reproduce on a fresh HAPI container per the conformance harness header (`docs/STANDARDS_CONFORMANCE.md`, the `conformance` skill): load the 7 MADiE cases, run `$evaluate-measure`, confirm `NUMER 1→0` vs our executor's `NUMER 1` (which matches MADiE's expected).
- [ ] Per case, bisect the `Numerator` define through its conjuncts (screening instrument retrieve, result-value comparison, follow-up on the same day, age-banded instrument choice) by evaluating each sub-expression on both engines; record the first differing define.
- [ ] Classify: HAPI-side (e.g. element omitted by the MADiE case that `cqf-fhir-cr` needs, as CMS122's `dosageInstruction` was), case-side, or ours. Write the finding with the table `case | first differing define | classification | evidence`.
- [ ] If "ours": STOP and hand to the owner with the fix scoped (Outcome B). Otherwise CMS2 clears.

### Task 13: CMS130 + CMS165 second-engine sweep (timebox 1 day)

- [ ] Same harness, all 64 + 68 vendored cases, completed terminology loaded (`pnpm vendor:official --complete-terminology` output from the credentialed workflow artifact if the local sidecar is capped).
- [ ] Record agreement counts per population; classify any disagreement as in Task 12; JOURNAL finding.

### Task 14: One flip PR per cleared measure (orchestrator-only — workflows)

- [ ] `WORKWELL_INSTANCE=maui corepack pnpm@10 flip-gate --measure <id>` → attach the JSON summary to the PR body.
- [ ] Edit `.github/workflows/deploy-maui-mieweb.yml:263` and `.github/workflows/reconcile-maui-mieweb.yml` (the `WORKWELL_OFFICIAL_MEASURES` value) to append `<id>`; `official-flip-config.test.ts` passes (structural + sidecar halves).
- [ ] Commit `feat(deploy): route <id> to its official artifact on Maui (MM-1c)`; PR body carries the gate report and the Task 12/13 finding link. After merge, the push-to-main deploy ships it; verify from the API (`GET /api/programs/overview` shows the measure with a non-zero denominator).

---

## Self-review against the spec

- §3 → T1 (+ boot line in T4). §4/§4.1 → T2, T3. §5 → T4. §6 → T5, T8, T9. §7 → T12–T14. §8 → T10. §9 → T6. §10 tests are distributed per task; the Maui e2e expectation (five measures) is added in T9's frontend step. §11 → T7, T11. §12 → PR split above. §13/§14 → no task needed.
- Type consistency: `classifyRunnable(id, env)` and `RunnableKind` (T1) are what T2's composite and T9's read model call; `SubjectBundleSource` (T2) is what T3 extends and T10 uses; `effectivePeriodWarning(artifact, period)` (T4) is what T10 calls; `matchesSeedFingerprint(row, catalog, expectedStatus?)` (T5) has one signature.
