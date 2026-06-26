# E12 PR-1 — Pluggable data ingress + DB-less JSON-bucket adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pluggable patient-data ingress seam above the unchanged CQL engine: a DB-less JSON-bucket library entry (`evaluateBundle` single + `evaluateBatch` over many, with per-item error isolation), a `PatientDataSource` port + `resolveDataSource(env)` config selection, and an inert WebChart stub — realizing E12 (#184) acceptance (b) + (c), and (a) at the seam.

**Architecture:** A new `backend-ts/src/engine/ingress/` module sits *above* `CqlExecutionEngine` and never modifies it. `evaluate-bundle.ts` is the DB-less, fs-less library entry (a thin shell over the engine). `data-source.ts` is the `PatientDataSource` port + the JSON-bucket adapter + the inert WebChart stub + `resolveDataSource` (mirrors the shipped `resolveForecaster`/`resolveChannel` inert-unless-configured pattern). The headless CLI is refactored to reuse `evaluateBundle` (one evaluation path). No schema, no new deps.

**Tech Stack:** Backend TypeScript on `@mieweb/cloud`. Tests use `node:test` + `node:assert/strict`, run via `node --import tsx --test src/engine/ingress/<file>.test.ts`. Full suite/typecheck via `corepack pnpm@10 test` / `corepack pnpm@10 typecheck` from `backend-ts/` (`pnpm` is only on PATH via `corepack`).

**Spec:** `docs/superpowers/specs/2026-06-26-e12-data-adapters-design.md`
**Branch:** `feat/e12-data-adapters` (the design is already committed here).

**Conventions:**
- Commit per task, conventional, scope `(e12)`, reference `#184`. Footer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- The library path (`evaluate-bundle.ts`, `data-source.ts`) must NOT import `node:fs` or any DB — it must stay portable across every `@mieweb/cloud` target (Workers included). File I/O stays at the CLI edge only. (Test files MAY use `node:fs` to load fixtures — tests aren't the portable runtime path.)
- The core engine (`CqlExecutionEngine`) is NOT modified by this PR.

**Key facts about the engine (already verified — do not re-derive):**
- `CqlExecutionEngine` (`backend-ts/src/engine/cql/cql-execution-engine.ts`) implements `EvaluateMeasureBinding` and exposes `evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome>` where `EvaluateMeasureInput = { measureId: string; patientBundle: unknown; evaluationDate?: string }` (types in `backend-ts/src/engine/evaluate-measure.ts`). It evaluates the FIRST patient in the bundle and throws `"no patient in bundle to evaluate"` for a bundle with no Patient (e.g. `{}`), and `"unknown measure '<id>'"` for an unknown measure id. Constructing it loads `FHIRHelpers` ELM once.
- Test fixtures: `backend-ts/spike/synthetic/<measureId>/<scenario>.json` are real FHIR bundles. Scenarios + expected outcomes (eval date `2026-06-12`): `present_recent → COMPLIANT`, `present_old → OVERDUE` (RECURRING measures; PERMANENT stay COMPLIANT), `missing → MISSING_DATA`, `excluded → EXCLUDED`. Subject id is `<measureId>-<scenario>` (e.g. `audiogram-present_recent`). `audiogram` is RECURRING. (See `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts` for the exact fixture-loading idiom.)

---

## File Structure

**Create:**
- `backend-ts/src/engine/ingress/evaluate-bundle.ts` — `evaluateBundle`, `evaluateBatch`, `BatchResult`/`BatchItemResult`/`EvaluateBundleOptions` types (DB-less library entry).
- `backend-ts/src/engine/ingress/data-source.ts` — `PatientDataSource` port, `jsonBucketDataSource`, `webChartDataSource` (inert stub), `resolveDataSource`, `evaluateSource`.
- `backend-ts/src/engine/ingress/index.ts` — public re-exports.
- `backend-ts/src/engine/ingress/evaluate-bundle.test.ts`
- `backend-ts/src/engine/ingress/data-source.test.ts`

**Modify:**
- `backend-ts/src/engine/cli/evaluate-measure-cli.ts` — `evaluate()` delegates to `evaluateBundle` (DRY); drop the now-unused `CqlExecutionEngine` import.

**Docs (Task 5):** `docs/DECISIONS.md` (new ADR), `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`, `README.md`.

---

## Task 1: DB-less library entry — `evaluateBundle` + `evaluateBatch`

**Files:**
- Create: `backend-ts/src/engine/ingress/evaluate-bundle.ts`
- Create: `backend-ts/src/engine/ingress/evaluate-bundle.test.ts`

- [ ] **Step 1: Write the failing test.** Create `backend-ts/src/engine/ingress/evaluate-bundle.test.ts`:

```ts
/**
 * E12 PR-1 (#184): the DB-less JSON-bundle library entry — single (evaluateBundle) + batch
 * (evaluateBatch with per-item error isolation). Fixtures are the real spike/synthetic bundles.
 *   node --import tsx --test src/engine/ingress/evaluate-bundle.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateBundle, evaluateBatch } from "./evaluate-bundle.ts";
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

test("evaluateBundle: a single JSON bundle → MeasureOutcome, identical to the engine directly", async () => {
  const bundle = load("audiogram", "present_recent");
  const got = await evaluateBundle(bundle, "audiogram", { evaluationDate: EVAL });
  assert.equal(got.outcome, "COMPLIANT");
  assert.equal(got.subjectId, "audiogram-present_recent");
  const direct = await new CqlExecutionEngine().evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: EVAL });
  assert.deepEqual(got, direct); // the library entry adds no behavior
});

test("evaluateBundle: unknown measure propagates the engine error", async () => {
  await assert.rejects(() => evaluateBundle(load("audiogram", "present_recent"), "nope", { evaluationDate: EVAL }), /unknown measure 'nope'/);
});

test("evaluateBatch: a bucket of bundles → one result each, with per-bundle error isolation", async () => {
  const ok1 = load("audiogram", "present_recent");
  const ok2 = load("audiogram", "present_old");
  const bad = {}; // no Patient → engine throws; must NOT abort the batch
  const res = await evaluateBatch([ok1, bad, ok2], "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 3);
  assert.equal(res.succeeded, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.results[0]?.ok, true);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
  assert.equal(res.results[1]?.ok, false);
  assert.ok((res.results[1]?.error ?? "").length > 0);
  assert.equal(res.results[2]?.ok, true);
  assert.equal(res.results[2]?.outcome?.outcome, "OVERDUE");
});

test("evaluateBatch: empty bucket → zero totals", async () => {
  const res = await evaluateBatch([], "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 0);
  assert.equal(res.succeeded, 0);
  assert.equal(res.failed, 0);
  assert.equal(res.results.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd backend-ts && node --import tsx --test src/engine/ingress/evaluate-bundle.test.ts`
Expected: FAIL — module `./evaluate-bundle.ts` does not exist.

- [ ] **Step 3: Implement.** Create `backend-ts/src/engine/ingress/evaluate-bundle.ts`:

```ts
/**
 * DB-less library entry for evaluating a JSON/FHIR object — and a "bucket" of them — against a
 * measure (#184 / E12, FHIR-native-first). A thin shell over CqlExecutionEngine: NO DB and NO
 * node:fs, so it stays portable across every @mieweb/cloud target (Workers included). File I/O
 * lives only at the CLI edge. The core engine is untouched.
 */
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding, MeasureOutcome } from "../evaluate-measure.ts";

export interface EvaluateBundleOptions {
  /** YYYY-MM-DD; defaults to today (the engine's default for single, resolved explicitly for batch). */
  evaluationDate?: string;
  /** Injectable binding (tests); defaults to a lazily-created shared CqlExecutionEngine. */
  engine?: EvaluateMeasureBinding;
}

export interface BatchItemResult {
  index: number;
  ok: boolean;
  outcome?: MeasureOutcome; // present when ok
  error?: string;           // present when !ok
}

export interface BatchResult {
  measureId: string;
  evaluationDate: string;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
}

const today = (): string => new Date().toISOString().slice(0, 10);

// Lazily-created shared default engine — constructing it loads FHIRHelpers ELM once.
let defaultEngine: EvaluateMeasureBinding | undefined;
const engineOf = (opts?: EvaluateBundleOptions): EvaluateMeasureBinding =>
  opts?.engine ?? (defaultEngine ??= new CqlExecutionEngine());

/** Evaluate a single JSON/FHIR bundle against a measure. No DB. */
export function evaluateBundle(
  bundle: unknown,
  measureId: string,
  opts?: EvaluateBundleOptions,
): Promise<MeasureOutcome> {
  return engineOf(opts).evaluate({ measureId, patientBundle: bundle, evaluationDate: opts?.evaluationDate });
}

/**
 * Evaluate a "bucket" of bundles, isolating per-bundle errors: each evaluate is wrapped so one bad
 * bundle (malformed / no Patient / unknown structure) never aborts the rest. Returns one result per
 * input index, in order. All items share one evaluationDate (resolved once for a consistent report).
 */
export async function evaluateBatch(
  bundles: unknown[],
  measureId: string,
  opts?: EvaluateBundleOptions,
): Promise<BatchResult> {
  const evaluationDate = opts?.evaluationDate ?? today();
  const engine = engineOf(opts);
  const results: BatchItemResult[] = [];
  for (let index = 0; index < bundles.length; index++) {
    try {
      const outcome = await engine.evaluate({ measureId, patientBundle: bundles[index], evaluationDate });
      results.push({ index, ok: true, outcome });
    } catch (e) {
      results.push({ index, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { measureId, evaluationDate, total: bundles.length, succeeded, failed: results.length - succeeded, results };
}
```

- [ ] **Step 4: Run it to verify it passes.**

Run: `cd backend-ts && node --import tsx --test src/engine/ingress/evaluate-bundle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add backend-ts/src/engine/ingress/evaluate-bundle.ts backend-ts/src/engine/ingress/evaluate-bundle.test.ts
git commit -m "feat(e12): DB-less evaluateBundle + evaluateBatch library entry (#184)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The `PatientDataSource` port + JSON-bucket adapter + inert WebChart stub + selection

**Files:**
- Create: `backend-ts/src/engine/ingress/data-source.ts`
- Create: `backend-ts/src/engine/ingress/data-source.test.ts`

- [ ] **Step 1: Write the failing test.** Create `backend-ts/src/engine/ingress/data-source.test.ts`:

```ts
/**
 * E12 PR-1 (#184): the PatientDataSource port — JSON-bucket adapter (default), inert WebChart stub
 * (inert-unless-configured), resolveDataSource selection, and evaluateSource sugar.
 *   node --import tsx --test src/engine/ingress/data-source.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { jsonBucketDataSource, webChartDataSource, resolveDataSource, evaluateSource } from "./data-source.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

test("jsonBucketDataSource: single object, array, and empty input load to the right length", async () => {
  assert.equal((await jsonBucketDataSource({ a: 1 }).loadBundles()).length, 1);
  assert.equal((await jsonBucketDataSource([{ a: 1 }, { b: 2 }]).loadBundles()).length, 2);
  assert.equal((await jsonBucketDataSource(undefined).loadBundles()).length, 0); // no input → empty bucket
  assert.equal(jsonBucketDataSource({}).kind, "json");
});

test("resolveDataSource: defaults to JSON; selects WebChart only when BOTH env vars are set", () => {
  assert.equal(resolveDataSource({}, { a: 1 }).kind, "json");
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x" }, { a: 1 }).kind, "json"); // only one set → JSON
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_API_KEY: "k" }, { a: 1 }).kind, "json");  // only one set → JSON
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: " ", WORKWELL_WEBCHART_API_KEY: "k" }, { a: 1 }).kind, "json"); // blank-after-trim → JSON
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x", WORKWELL_WEBCHART_API_KEY: "k" }).kind, "webchart");
});

test("webChartDataSource: inert stub rejects with a clear PR-2 message", async () => {
  await assert.rejects(() => webChartDataSource({ baseUrl: "x", apiKey: "k" }).loadBundles(), /not yet wired \(E12 PR-2\)/);
});

test("evaluateSource: evaluates every bundle a JSON source yields", async () => {
  const src = jsonBucketDataSource([load("audiogram", "present_recent"), load("audiogram", "missing")]);
  const res = await evaluateSource(src, "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 2);
  assert.equal(res.succeeded, 2);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
  assert.equal(res.results[1]?.outcome?.outcome, "MISSING_DATA");
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd backend-ts && node --import tsx --test src/engine/ingress/data-source.test.ts`
Expected: FAIL — module `./data-source.ts` does not exist.

- [ ] **Step 3: Implement.** Create `backend-ts/src/engine/ingress/data-source.ts`:

```ts
/**
 * The pluggable patient-data ingress (#184 / E12, FHIR-native-first). A PatientDataSource yields the
 * FHIR bundles to evaluate; the engine derives each subject id from its bundle. JSON-bucket is the
 * default, in-memory, DB-less source. The WebChart source is an INERT stub until E12 PR-2
 * (inert-unless-configured, mirroring resolveForecaster / resolveChannel / resolveStandingOrderProvider).
 * NO DB, NO node:fs here — this stays portable across every @mieweb/cloud target.
 */
import { evaluateBatch, type BatchResult, type EvaluateBundleOptions } from "./evaluate-bundle.ts";

export interface PatientDataSource {
  /** Diagnostic tag — "json" | "webchart". */
  readonly kind: string;
  /** The bundles ("bucket") to evaluate. DB-less for the JSON source. */
  loadBundles(): Promise<unknown[]>;
}

/** In-memory JSON bucket: one bundle, an array of bundles, or nothing (→ empty bucket). No DB, no fs. */
export function jsonBucketDataSource(input?: unknown | unknown[]): PatientDataSource {
  const bundles = input === undefined ? [] : Array.isArray(input) ? input : [input];
  return { kind: "json", loadBundles: () => Promise.resolve(bundles) };
}

export interface WebChartConfig {
  baseUrl: string;
  apiKey: string;
}

/** Inert WebChart stub — wired in E12 PR-2. Selected only when its env vars are set. */
export function webChartDataSource(_cfg: WebChartConfig): PatientDataSource {
  return {
    kind: "webchart",
    loadBundles: () => Promise.reject(new Error("WebChart data source not yet wired (E12 PR-2)")),
  };
}

export interface DataSourceEnv {
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;
}

/**
 * Config-driven ingress selection (mirrors resolveForecaster/resolveChannel): JSON is the default;
 * WebChart is selected only when BOTH env vars are non-blank (inert until PR-2). The JSON source
 * needs the caller's bundles (inherent to JSON ingress), passed as jsonInput.
 */
export function resolveDataSource(env: DataSourceEnv, jsonInput?: unknown | unknown[]): PatientDataSource {
  const baseUrl = (env.WORKWELL_WEBCHART_BASE_URL ?? "").trim();
  const apiKey = (env.WORKWELL_WEBCHART_API_KEY ?? "").trim();
  if (baseUrl && apiKey) return webChartDataSource({ baseUrl, apiKey });
  return jsonBucketDataSource(jsonInput);
}

/** Evaluate every bundle a source yields against a measure (sugar over loadBundles + evaluateBatch). */
export async function evaluateSource(
  source: PatientDataSource,
  measureId: string,
  opts?: EvaluateBundleOptions,
): Promise<BatchResult> {
  return evaluateBatch(await source.loadBundles(), measureId, opts);
}
```

- [ ] **Step 4: Run it to verify it passes.**

Run: `cd backend-ts && node --import tsx --test src/engine/ingress/data-source.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add backend-ts/src/engine/ingress/data-source.ts backend-ts/src/engine/ingress/data-source.test.ts
git commit -m "feat(e12): PatientDataSource port + JSON-bucket adapter + inert WebChart stub + resolveDataSource (#184)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Public exports — `index.ts`

**Files:**
- Create: `backend-ts/src/engine/ingress/index.ts`

- [ ] **Step 1: Implement.** Create `backend-ts/src/engine/ingress/index.ts`:

```ts
/**
 * E12 (#184) pluggable patient-data ingress — public surface.
 * DB-less JSON-bucket evaluation today; WebChart adapter is an inert stub until E12 PR-2.
 */
export {
  evaluateBundle,
  evaluateBatch,
  type EvaluateBundleOptions,
  type BatchItemResult,
  type BatchResult,
} from "./evaluate-bundle.ts";
export {
  type PatientDataSource,
  jsonBucketDataSource,
  webChartDataSource,
  type WebChartConfig,
  type DataSourceEnv,
  resolveDataSource,
  evaluateSource,
} from "./data-source.ts";
```

- [ ] **Step 2: Typecheck.**

Run: `cd backend-ts && corepack pnpm@10 typecheck`
Expected: clean (no output). This validates the barrel's re-exports resolve.

- [ ] **Step 3: Commit.**

```bash
git add backend-ts/src/engine/ingress/index.ts
git commit -m "feat(e12): ingress public barrel (index.ts) (#184)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: CLI refactor — reuse the shared `evaluateBundle` (DRY, behavior-preserving)

**Files:**
- Modify: `backend-ts/src/engine/cli/evaluate-measure-cli.ts`

The CLI's `evaluate()` currently constructs `new CqlExecutionEngine()` and calls `.evaluate(...)` inline. Refactor it to call the shared `evaluateBundle(...)` so there is ONE evaluation path. Behavior must be identical (the existing CLI tests must stay green).

- [ ] **Step 1: Edit `evaluate()` + the import.** In `backend-ts/src/engine/cli/evaluate-measure-cli.ts`:
  - Replace the import line `import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";` with:
    ```ts
    import { evaluateBundle } from "../ingress/evaluate-bundle.ts";
    ```
  - Replace the body of `evaluate(parsed)` (the part AFTER the `JSON.parse(readFileSync(...))` try/catch that sets `bundle`) — i.e. replace:
    ```ts
      const engine = new CqlExecutionEngine();
      return engine.evaluate({ measureId: parsed.measure, patientBundle: bundle, evaluationDate: parsed.date });
    ```
    with:
    ```ts
      return evaluateBundle(bundle, parsed.measure, { evaluationDate: parsed.date });
    ```
  (Leave the `readFileSync` + `CliUsageError`-on-unreadable-bundle logic exactly as-is — file I/O stays at the CLI edge.)

- [ ] **Step 2: Run the CLI tests to verify no behavior change.**

Run: `cd backend-ts && node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts`
Expected: PASS (all — including the golden regression over every measure and the bin exit-code tests). This proves the refactor is behavior-preserving.

- [ ] **Step 3: Typecheck (confirms the removed `CqlExecutionEngine` import isn't referenced elsewhere in the file).**

Run: `cd backend-ts && corepack pnpm@10 typecheck`
Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add backend-ts/src/engine/cli/evaluate-measure-cli.ts
git commit -m "refactor(e12): CLI evaluate() reuses the shared evaluateBundle entry (#184)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Docs (ADR + ARCHITECTURE + JOURNAL + README) + full verification + PR

**Files:** `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`, `README.md`.

- [ ] **Step 1: ADR in `docs/DECISIONS.md`.** Read the file, find the highest existing ADR number (expected latest is ADR-016; use the next integer — expected **ADR-017** — but VERIFY against the file and use whatever is actually next). Add a dated ADR matching the file's existing ADR format. Content: **"E12 data ingress is FHIR-native-first; adapters feed the unchanged engine (no CQL→SQL transpile)."** Record: the E9 (#78) fork decision (FHIR-native adapter vs CQL→SQL transpile vs hybrid → FHIR-native-first); the `PatientDataSource` port + DB-less JSON-bucket library entry (PR-1); WebChart adapter as an inert-unless-configured stub now, real mapping in PR-2; CQL `Outcome Status` stays the sole compliance authority (ADR-008); no schema, no new deps. Keep it proportional to the other ADRs.

- [ ] **Step 2: `docs/ARCHITECTURE.md`.** Two surgical edits (read the surrounding sections first to match prose/format):
  - §3 Backend Module Boundaries: add an `engine.ingress` bullet (or extend the `engine` bullet) describing the new module — the `PatientDataSource` port + `jsonBucketDataSource` (DB-less library entry: `evaluateBundle`/`evaluateBatch`) + the inert `webChartDataSource` stub + `resolveDataSource` (config-driven, inert-unless-configured). Note it sits above the unchanged `CqlExecutionEngine` (FHIR-native-first; ADR-017).
  - §7 External Interfaces (or the headless-CLI bullet near the E2 mention): add a line that the headless evaluation is now also a DB-less **library** entry (`evaluateBundle(bundle, measureId)` / `evaluateBatch(bundles, measureId)`), reused by the CLI.

- [ ] **Step 3: `docs/JOURNAL.md`.** Add a new top entry dated 2026-06-26 (match the house style; read the top entries first) summarizing E12 PR-1: the FHIR-native-first fork decision (ADR-017), the `engine/ingress/` module (DB-less JSON-bucket library entry + batch with per-item error isolation + `PatientDataSource` port + `resolveDataSource` + inert WebChart stub), the CLI refactor to reuse it; "no schema, no new deps"; backend suite green; PR-2 (WebChart/MariaDB depth) deferred.

- [ ] **Step 4: `README.md`.** In the "Headless evaluation" section (the `pnpm evaluate` block), add 1–2 sentences that the same DB-less evaluation is available as a **library** entry (`evaluateBundle` / `evaluateBatch` from `backend-ts/src/engine/ingress`) for evaluating a JSON object or a bucket of them without a server or DB. Keep it short; match the surrounding prose.

- [ ] **Step 5: Commit docs.**

```bash
git add docs/DECISIONS.md docs/ARCHITECTURE.md docs/JOURNAL.md README.md
git commit -m "docs(e12): ADR-017 FHIR-native ingress + ARCHITECTURE/JOURNAL/README for PR-1 (#184)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Full verification.**

Run (from `backend-ts/`): `corepack pnpm@10 typecheck && corepack pnpm@10 test`
Expected: typecheck clean; all tests pass (the large suite, ~700+ now with the new ingress tests; the one Pg-ceiling contract test may self-skip if no local postgres — that's expected). If anything fails that this branch introduced, STOP and fix before proceeding.

- [ ] **Step 7: Whole-branch code review.** (Handled by the coordinator per the maintainer's standing rule — run `superpowers:code-reviewer` over `git diff main...feat/e12-data-adapters`. Address findings.)

- [ ] **Step 8: Push + PR (coordinator; do NOT merge — the maintainer reviews + merges).**

```bash
git push -u origin feat/e12-data-adapters
gh pr create --title "E12 PR-1 — pluggable data ingress + DB-less JSON-bucket adapter (#184)" --body "<summary; FHIR-native-first (ADR-017); evaluateBundle/evaluateBatch DB-less library entry; PatientDataSource port + resolveDataSource + inert WebChart stub; CLI refactor; no schema/new deps; PR-2 = WebChart depth; 🤖 Generated with Claude Code footer>"
```

Expected: CI green.

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 acceptance (b) DB-less JSON-bucket library entry → Tasks 1 (`evaluateBundle`/`evaluateBatch`) + the CLI reuse (Task 4). (c) config-driven selection → Task 2 (`resolveDataSource`, inert-unless-configured). (a) at the seam → Task 2 (`webChartDataSource` inert stub). §2 fork decision → Task 5 ADR-017. §5 architecture (module layout, port, library entry, selection) → Tasks 1–3. §6 data flow → Tasks 1–2. §7 error handling (batch isolation, unknown-measure propagation, WebChart stub error) → Task 1 + Task 2 tests. §8 testing → embedded per task (parity, batch isolation, empty bucket, selection, stub). §9 file structure → matches Tasks 1–4. ✅

**Placeholder scan:** All code shown in full; no TBD/TODO; the ADR number is the one explicit lookup (Task 5 Step 1 tells the implementer to verify the next integer — expected ADR-017 — rather than hard-coding wrongly). ✅

**Type consistency:** `EvaluateBundleOptions` / `BatchItemResult` / `BatchResult` defined once in Task 1 and re-exported (Task 3) + consumed by `evaluateSource` (Task 2). `PatientDataSource` defined in Task 2, used by `evaluateSource` + `resolveDataSource`. `evaluateBundle(bundle, measureId, opts?)` and `evaluateBatch(bundles, measureId, opts?)` signatures match across Task 1 (def), Task 2 (`evaluateSource` calls `evaluateBatch`), and Task 4 (CLI calls `evaluateBundle`). `resolveDataSource(env, jsonInput?)` and `WORKWELL_WEBCHART_BASE_URL`/`_API_KEY` consistent between the impl and the tests. ✅
