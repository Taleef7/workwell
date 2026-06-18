# E2 Headless Evaluator CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a packaged headless CLI — `pnpm evaluate --patient <bundle.json> --measure <id>` — that prints a measure's compliance outcome + evidence for one FHIR R4 patient bundle, with no server and no DB.

**Architecture:** A thin CLI shell over the existing, parity-proven `CqlExecutionEngine`. All evaluation stays in the engine; the CLI only parses args, reads the bundle file, delegates, and prints JSON. Split into a side-effect-free lib (`evaluate-measure-cli.ts`, exporting `parseArgs`/`evaluate`/`run`/`main`) and a 2-line runnable entry (`bin.ts`) so importing the lib in tests never executes `main` — avoiding any "is this module the entrypoint?" guard.

**Tech Stack:** TypeScript run via `tsx` (no build step), `node:test` + `node:assert/strict` (the repo's test runner), `node:fs`/`node:child_process`. Reuses `CqlExecutionEngine` (`cql-execution` + `cql-exec-fhir`) and the `spike/synthetic` golden corpus. No new dependency.

**Spec:** `docs/superpowers/specs/2026-06-18-e2-headless-evaluator-cli-design.md`
**Branch:** `feat/issue-72-headless-evaluator-cli`

**Conventions for every commit in this plan:** run from `backend-ts/`; conventional-commit subject; append the trailer
`-m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"`.

**Reference facts (verified):**
- Engine: `src/engine/cql/cql-execution-engine.ts` → `class CqlExecutionEngine implements EvaluateMeasureBinding`; `evaluate({ measureId, patientBundle, evaluationDate? }): Promise<MeasureOutcome>`. Throws `unknown measure '<id>'` and `no patient in bundle to evaluate`.
- `MeasureOutcome` (from `src/engine/evaluate-measure.ts`): `{ subjectId, measure, outcome, evidence: { expressionResults: { define, result }[] } }`; `OutcomeStatus = "COMPLIANT"|"DUE_SOON"|"OVERDUE"|"MISSING_DATA"|"EXCLUDED"`.
- Measure ids (`MEASURES` keys, `src/engine/cql/measure-registry.ts`): `audiogram, hazwoper, tb_surveillance, flu_vaccine, hypertension, diabetes_hba1c, obesity_bmi, cholesterol_ldl, cms125, cms122`.
- Golden corpus: `spike/synthetic/<measureId>/<scenario>.json` (bundles) for scenarios `present_recent, present_old, missing, excluded`; patient id is `<measureId>-<scenario>`. Pinned eval date `2026-06-12` (`spike/synthetic/_index.json`). Proven outcome map: `present_recent→COMPLIANT, present_old→OVERDUE, missing→MISSING_DATA, excluded→EXCLUDED` (identical to `cql-execution-engine.test.ts`).
- Imports use explicit `.ts` extensions. Test command: `node --import tsx --test "src/**/*.test.ts"`.

---

## File Structure

- Create `backend-ts/src/engine/cli/evaluate-measure-cli.ts` — arg parsing + I/O + delegation (no top-level execution). Exports `CliUsageError`, `parseArgs`, `evaluate`, `run`, `main`.
- Create `backend-ts/src/engine/cli/bin.ts` — runnable entry: calls `main(process.argv.slice(2))`, exits with its code.
- Create `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts` — unit (parseArgs + errors), golden regression (40 fixtures via `run`), subprocess smoke.
- Modify `backend-ts/package.json` — add `scripts.evaluate`.
- Modify `README.md` — replace the "Headless evaluation" stub with real invocation.
- Modify `docs/MEASURES.md` and `docs/ARCHITECTURE.md` — short note on the headless CLI.
- Modify `docs/JOURNAL.md` — add the E2 entry.

---

### Task 1: `parseArgs` — argument parsing (pure)

**Files:**
- Create: `backend-ts/src/engine/cli/evaluate-measure-cli.ts`
- Test: `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`:

```ts
/**
 * #72 / E2 headless CLI: arg-parsing units, golden regression over the
 * spike/synthetic corpus (via run()), and a subprocess smoke. Evaluation
 * parity itself is covered by cql-execution-engine.test.ts.
 *   node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliUsageError, parseArgs } from "./evaluate-measure-cli.ts";

test("parseArgs: parses required + optional flags", () => {
  const a = parseArgs(["--patient", "b.json", "--measure", "audiogram", "--date", "2026-06-12", "--pretty"]);
  assert.deepEqual(a, { patient: "b.json", measure: "audiogram", date: "2026-06-12", pretty: true });
});

test("parseArgs: pretty defaults false, date optional", () => {
  const a = parseArgs(["--patient", "b.json", "--measure", "flu_vaccine"]);
  assert.equal(a.pretty, false);
  assert.equal(a.date, undefined);
});

test("parseArgs: missing --patient throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--measure", "audiogram"]), CliUsageError);
});

test("parseArgs: missing --measure throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--patient", "b.json"]), CliUsageError);
});

test("parseArgs: bad --date format throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--patient", "b.json", "--measure", "audiogram", "--date", "06/12/2026"]), CliUsageError);
});

test("parseArgs: unknown flag throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--patient", "b.json", "--measure", "audiogram", "--bogus"]), CliUsageError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts`
Expected: FAIL — cannot resolve `./evaluate-measure-cli.ts` (module does not exist yet).

- [ ] **Step 3: Create the lib with `parseArgs` (and the types/exports the later tasks need)**

Create `backend-ts/src/engine/cli/evaluate-measure-cli.ts`:

```ts
/**
 * Headless evaluator CLI (#72 / E2): "given this patient bundle and this measure,
 * are they compliant?" — no server, no DB. A thin shell over CqlExecutionEngine
 * (the parity-proven, JVM-free engine); all evaluation lives there. This file is
 * arg-parsing + I/O + delegation only, and has NO top-level side effects so tests
 * can import it freely (bin.ts is the runnable entry).
 *
 *   pnpm evaluate --patient ./bundle.json --measure audiogram [--date 2026-06-18] [--pretty]
 */
import { readFileSync } from "node:fs";
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";
import type { MeasureOutcome } from "../evaluate-measure.ts";

export const USAGE =
  "Usage: pnpm evaluate --patient <bundle.json> --measure <id> [--date YYYY-MM-DD] [--pretty]";

/** Bad invocation (missing/unknown flags, unreadable bundle) — exit code 2. */
export class CliUsageError extends Error {}

export interface CliArgs {
  patient: string;
  measure: string;
  date?: string;
  pretty: boolean;
}

export function parseArgs(args: string[]): CliArgs {
  const out: Partial<CliArgs> = { pretty: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--patient") out.patient = args[++i];
    else if (a === "--measure") out.measure = args[++i];
    else if (a === "--date") out.date = args[++i];
    else if (a === "--pretty") out.pretty = true;
    else throw new CliUsageError(`unknown argument '${a}'\n${USAGE}`);
  }
  if (!out.patient) throw new CliUsageError(`--patient <bundle.json> is required\n${USAGE}`);
  if (!out.measure) throw new CliUsageError(`--measure <id> is required\n${USAGE}`);
  if (out.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(out.date))
    throw new CliUsageError(`--date must be YYYY-MM-DD\n${USAGE}`);
  return out as CliArgs;
}

/** Read the bundle file + delegate to the engine. Throws CliUsageError on a bad bundle. */
export async function evaluate(parsed: CliArgs): Promise<MeasureOutcome> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(parsed.patient, "utf8"));
  } catch (e) {
    throw new CliUsageError(`cannot read patient bundle '${parsed.patient}': ${(e as Error).message}`);
  }
  const engine = new CqlExecutionEngine();
  return engine.evaluate({ measureId: parsed.measure, patientBundle: bundle, evaluationDate: parsed.date });
}

/** Convenience for tests: parse + evaluate in one call. */
export async function run(args: string[]): Promise<MeasureOutcome> {
  return evaluate(parseArgs(args));
}

/**
 * Full CLI: parse → evaluate → print JSON to stdout. Returns the process exit code.
 * 2 = usage error, 1 = evaluation error (unknown measure / empty bundle), 0 = success.
 * Errors go to stderr; stdout carries only the JSON so `... | jq` is safe.
 */
export async function main(args: string[]): Promise<number> {
  let parsed: CliArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  try {
    const outcome = await evaluate(parsed);
    process.stdout.write(`${JSON.stringify(outcome, null, parsed.pretty ? 2 : 0)}\n`);
    return 0;
  } catch (e) {
    const code = e instanceof CliUsageError ? 2 : 1;
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return code;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts`
Expected: PASS — all 6 `parseArgs` tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
cd backend-ts && pnpm typecheck
git add src/engine/cli/evaluate-measure-cli.ts src/engine/cli/evaluate-measure-cli.test.ts
git commit -m "feat(engine-cli): #72 parseArgs + CLI lib skeleton for the headless evaluator" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Expected: typecheck clean; commit succeeds.

---

### Task 2: `run` / `evaluate` — bundle read + engine delegation

**Files:**
- Modify: `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`
- (Implementation already written in Task 1 — this task proves `run`/`evaluate` behavior.)

- [ ] **Step 1: Add the failing behavior tests**

Append to `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`:

```ts
import { run, evaluate } from "./evaluate-measure-cli.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const fixture = (m: string, s: string) => path.join(SYNTH, m, `${s}.json`);

test("run: evaluates a real bundle → MeasureOutcome shape", async () => {
  const outcome = await run(["--patient", fixture("audiogram", "present_recent"), "--measure", "audiogram", "--date", "2026-06-12"]);
  assert.equal(outcome.outcome, "COMPLIANT");
  assert.equal(outcome.measure, "Audiogram");
  assert.equal(outcome.subjectId, "audiogram-present_recent");
  assert.ok(outcome.evidence.expressionResults.some((r) => r.define === "Outcome Status"));
});

test("evaluate: unreadable bundle → CliUsageError", async () => {
  await assert.rejects(
    () => evaluate({ patient: path.join(SYNTH, "does-not-exist.json"), measure: "audiogram", pretty: false }),
    CliUsageError,
  );
});

test("evaluate: unknown measure → Error (not CliUsageError)", async () => {
  await assert.rejects(
    () => evaluate({ patient: fixture("audiogram", "present_recent"), measure: "nope", pretty: false }),
    /unknown measure 'nope'/,
  );
});
```

- [ ] **Step 2: Run to verify it passes (implementation exists from Task 1)**

Run: `cd backend-ts && node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts`
Expected: PASS — the new `run`/`evaluate` tests pass alongside the `parseArgs` tests.

- [ ] **Step 3: Commit**

```bash
cd backend-ts
git add src/engine/cli/evaluate-measure-cli.test.ts
git commit -m "test(engine-cli): #72 cover run()/evaluate() bundle read + delegation + errors" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Golden regression over the 40 spike/synthetic fixtures

**Files:**
- Modify: `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`

- [ ] **Step 1: Add the golden regression test**

Append to `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`:

```ts
import { MEASURES } from "../cql/measure-registry.ts";

const EVAL = "2026-06-12";
const EXPECTED: Record<string, string> = {
  present_recent: "COMPLIANT",
  present_old: "OVERDUE",
  missing: "MISSING_DATA",
  excluded: "EXCLUDED",
};

for (const measureId of Object.keys(MEASURES)) {
  test(`golden: CLI matches expected outcomes for ${measureId} (all scenarios)`, async () => {
    for (const [scenario, expected] of Object.entries(EXPECTED)) {
      const outcome = await run(["--patient", fixture(measureId, scenario), "--measure", measureId, "--date", EVAL]);
      assert.equal(outcome.outcome, expected, `${measureId}/${scenario}`);
      assert.equal(outcome.measure, MEASURES[measureId]!.name);
    }
  });
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts`
Expected: PASS — 10 golden tests (one per measure), each asserting 4 scenarios = 40 outcome assertions, all green.

- [ ] **Step 3: Commit**

```bash
cd backend-ts
git add src/engine/cli/evaluate-measure-cli.test.ts
git commit -m "test(engine-cli): #72 golden regression — CLI outcomes across all 10 measures x 4 scenarios" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Runnable entry (`bin.ts`) + `pnpm evaluate` script

**Files:**
- Create: `backend-ts/src/engine/cli/bin.ts`
- Modify: `backend-ts/package.json`

- [ ] **Step 1: Create the thin runnable entry**

Create `backend-ts/src/engine/cli/bin.ts`:

```ts
#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the headless evaluator CLI (#72). Kept to two lines so the
 * lib (evaluate-measure-cli.ts) stays side-effect-free and importable by tests.
 *   pnpm evaluate --patient ./bundle.json --measure audiogram
 */
import { main } from "./evaluate-measure-cli.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
```

- [ ] **Step 2: Add the `evaluate` script to package.json**

In `backend-ts/package.json`, add to the `"scripts"` object (alongside `dev`, `start`, `compile-measures`):

```json
    "evaluate": "tsx src/engine/cli/bin.ts",
```

- [ ] **Step 3: Manual smoke — run the CLI against a fixture**

Run (from `backend-ts/`):
```bash
pnpm evaluate --patient spike/synthetic/audiogram/present_recent.json --measure audiogram --date 2026-06-12 --pretty
```
Expected: prints JSON with `"outcome": "COMPLIANT"`, `"measure": "Audiogram"`, `"subjectId": "audiogram-present_recent"`, and an `expressionResults` array including `"Outcome Status"`. Exit code 0.

- [ ] **Step 4: Manual smoke — error path**

Run: `pnpm evaluate --measure audiogram` (missing `--patient`)
Expected: stderr prints the `--patient ... is required` usage line; nothing on stdout; non-zero exit (`echo $?` → 2).

- [ ] **Step 5: Typecheck + commit**

```bash
cd backend-ts && pnpm typecheck
git add src/engine/cli/bin.ts package.json
git commit -m "feat(engine-cli): #72 add runnable bin + pnpm evaluate script" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Subprocess smoke test (proves the bin wiring + exit codes)

**Files:**
- Modify: `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`

- [ ] **Step 1: Add the subprocess smoke test**

Append to `backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`:

```ts
import { spawnSync } from "node:child_process";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));
// Run the bin with the same node + tsx loader the repo's test script uses (no reliance on a tsx on PATH).
const runCli = (args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", BIN, ...args], { encoding: "utf8" });

test("bin: success → exit 0 + clean JSON on stdout", () => {
  const r = runCli(["--patient", fixture("audiogram", "present_recent"), "--measure", "audiogram", "--date", "2026-06-12"]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.outcome, "COMPLIANT");
  assert.equal(parsed.subjectId, "audiogram-present_recent");
});

test("bin: usage error → exit 2 + stderr message + empty stdout", () => {
  const r = runCli(["--measure", "audiogram"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--patient .* is required/);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts`
Expected: PASS — both subprocess tests green (success exit 0 + parseable JSON; usage error exit 2 + empty stdout).

- [ ] **Step 3: Run the full backend-ts suite (no regressions)**

Run: `cd backend-ts && pnpm test`
Expected: the full suite passes, including the new CLI tests; no existing test breaks.

- [ ] **Step 4: Commit**

```bash
cd backend-ts
git add src/engine/cli/evaluate-measure-cli.test.ts
git commit -m "test(engine-cli): #72 subprocess smoke — bin exit codes + clean stdout" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Docs + reopen #72

**Files:**
- Modify: `README.md` (the "Headless evaluation (patient + YAML → compliant?)" section)
- Modify: `docs/MEASURES.md` (add a short note under "Implementation Notes")
- Modify: `docs/ARCHITECTURE.md` (note the CLI under §7 External Interfaces)
- Modify: `docs/JOURNAL.md` (new top entry)

- [ ] **Step 1: Update the README headless section**

In `README.md`, replace the paragraph that says *"A packaged headless CLI is tracked under **E2** (#72 …)"* with real invocation:

```markdown
Run it from `backend-ts/` — no server, no database:

```bash
pnpm evaluate --patient ./patient-bundle.json --measure audiogram --date 2026-06-12 --pretty
```

`--measure` is a registry id (`audiogram`, `hazwoper`, `tb_surveillance`, `flu_vaccine`,
`hypertension`, `diabetes_hba1c`, `obesity_bmi`, `cholesterol_ldl`, `cms125`, `cms122`);
`--date` defaults to today. Output is the `MeasureOutcome` JSON:
```

(Keep the existing JSON example block that follows.)

- [ ] **Step 2: Add a MEASURES note**

In `docs/MEASURES.md`, under "Implementation Notes", add:

```markdown
- A headless CLI (`pnpm evaluate --patient <bundle.json> --measure <id>`, `backend-ts/src/engine/cli/`)
  evaluates one FHIR R4 patient bundle against a measure with no server or DB — the same
  `CqlExecutionEngine` the run pipeline uses. Golden regression over `backend-ts/spike/synthetic`
  asserts outcomes for all 10 measures × 4 scenarios (#72 / E2).
```

- [ ] **Step 3: Add an ARCHITECTURE note**

In `docs/ARCHITECTURE.md` §7 (External Interfaces), add a bullet:

```markdown
- Headless evaluator CLI (`backend-ts/src/engine/cli/`): `pnpm evaluate --patient <bundle.json> --measure <id>` → `MeasureOutcome` JSON on stdout, no server/DB. A thin shell over `CqlExecutionEngine` (#72 / E2).
```

- [ ] **Step 4: Add the JOURNAL entry**

In `docs/JOURNAL.md`, add a new top entry dated `2026-06-18`:

```markdown
## 2026-06-18 — E2 (#72): headless evaluator CLI

Shipped the packaged headless evaluator Doug asked for: `pnpm evaluate --patient <bundle.json>
--measure <id>` prints a measure's `MeasureOutcome` (bucket + define-level evidence) for one FHIR
R4 bundle, no server and no DB. It's a thin shell (`src/engine/cli/`: a side-effect-free lib +
a 2-line `bin.ts`) over the existing parity-proven `CqlExecutionEngine` — no new evaluation logic,
no runtime YAML loader (de-scoped), no new dependency. Golden regression drives the CLI over the
`spike/synthetic` corpus (10 measures × 4 scenarios) asserting outcomes, plus a subprocess smoke
for exit codes + clean stdout. Closes the last open acceptance item of E2.
```

- [ ] **Step 5: Reopen / reference #72**

Run:
```bash
gh issue reopen 72 --comment "Reopening to land the headless CLI (the third acceptance item). Branch: feat/issue-72-headless-evaluator-cli."
```
(If the maintainer prefers to leave it closed, skip — this step is bookkeeping only.)

- [ ] **Step 6: Commit**

```bash
git add README.md docs/MEASURES.md docs/ARCHITECTURE.md docs/JOURNAL.md
git commit -m "docs: #72 E2 — document the headless evaluator CLI" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd backend-ts && pnpm typecheck` → clean.
- [ ] `cd backend-ts && pnpm test` → full suite green (incl. the new CLI unit + golden + subprocess tests).
- [ ] `pnpm evaluate --patient spike/synthetic/cms122/excluded.json --measure cms122 --date 2026-06-12 --pretty` → prints `"outcome": "EXCLUDED"`, exit 0.
- [ ] README headless section shows the real command (no "tracked under E2" stub).
- [ ] Open a PR from `feat/issue-72-headless-evaluator-cli` for maintainer review (no auto-merge).

## Self-review (against the spec)

- **Spec §3 in-scope items** — CLI with `--patient/--measure/--date/--pretty` (Tasks 1,4), `pnpm evaluate` + bin (Task 4), golden over 40 fixtures (Task 3), subprocess smoke (Task 5), docs + reopen #72 (Task 6). ✓
- **Spec §4.1 boundary** — lib does I/O + delegation only; engine untouched. The fragile "is-main" guard is replaced by the lib/bin split (an improvement over the spec's `import.meta`-main note; recorded here). ✓
- **Spec §4.2 contract** — stdout JSON, `--pretty`, exit `0`/`2`/`1`, errors to stderr, clean stdout. ✓ (Spec said unknown-measure = non-zero; plan classifies it as exit 1 and usage problems as exit 2 — a refinement, still non-zero as required.)
- **Spec §4.3 packaging** — `pnpm evaluate` is the primary entry; the npm `bin` field is **dropped** (a `.ts` bin target isn't portably runnable via npm shims without a build). The spec pre-authorized treating `bin` as optional/droppable; the `bin.ts` file + shebang remain for direct `node --import tsx` execution. ✓
- **Spec §5 testing** — golden via in-process `run()` (Task 3), arg/output contract (Tasks 1–2), one subprocess smoke + error-exit (Task 5). The fixture→bucket table is the proven simple 4-way map (matches `cql-execution-engine.test.ts`), so §7's flu/CMS122 risk does not materialize — no per-measure exception table needed. ✓
- **Placeholder scan** — no TBD/TODO; every code step has complete code; commands have expected output. ✓
- **Type consistency** — `CliArgs`, `parseArgs`, `evaluate`, `run`, `main`, `MeasureOutcome` names match across Tasks 1–5. ✓
