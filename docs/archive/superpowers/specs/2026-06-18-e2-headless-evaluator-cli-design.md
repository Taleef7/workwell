# E2 — Headless Evaluator CLI — Design

Date: 2026-06-18
Epic: #72 (E2 — declarative YAML measures + headless evaluator)
Status: Approved (brainstorm) — pending spec review
Branch: `feat/issue-72-headless-evaluator-cli`

## 1) Goal

Ship a packaged **headless CLI** that answers Doug's concrete ask — *"given this patient
bundle and this measure, are they compliant?"* — outside the web app, with **no server and
no database**. The CLI prints the compliance bucket + per-define evidence for one FHIR R4
patient bundle.

This closes the third (unshipped) acceptance item of #72: *"Headless CLI/endpoint: patient
bundle + measure → bucket + evidence."* The other two items are already met — the declarative
YAML measures exist (`backend-ts/measures/*.yaml`) and drive the build-time binding/ELM
generation, and the evaluator core exists and is parity-proven (see §2).

## 2) Current state (what we reuse, not rebuild)

The evaluator already exists and is the load-bearing piece:

- **`backend-ts/src/engine/cql/cql-execution-engine.ts` — `CqlExecutionEngine`** implements the
  `EvaluateMeasureBinding` contract (`backend-ts/src/engine/evaluate-measure.ts`):
  `evaluate({ measureId, patientBundle, evaluationDate? }) → Promise<MeasureOutcome>`.
  It executes committed ELM (compiled JVM-free by `scripts/compile-measures.mjs`) against a FHIR
  R4 bundle via `cql-execution` + `cql-exec-fhir`. It is **already** the headless, DB-free,
  server-free engine, and is the same path the live run pipeline uses. Comment records it is
  "byte-equal to the Java engine across all 10 measures × 4 scenarios."
- **`MeasureOutcome`** shape (the CLI's output contract):
  `{ subjectId, measure, outcome, evidence: { expressionResults: [{ define, result }] } }`.
- **`MEASURES` registry** (`measure-registry.ts`) resolves a measure id → ELM library + the
  Measurement-Period window (`periodMonths`).
- **Golden corpus already exists:** `backend-ts/spike/synthetic/<measureId>/{present_recent,
  present_old,missing,excluded}.json` — synthetic FHIR bundles for all 10 measures × 4 scenarios.

**Therefore E2 = a thin CLI shell around `CqlExecutionEngine` + a golden regression + docs.**
No evaluation logic, no runtime YAML loader (explicitly de-scoped), no new dependency.

## 3) Scope

In scope:
- A CLI entry that takes `--patient <file> --measure <id> [--date YYYY-MM-DD] [--pretty]`,
  reads the bundle, calls `CqlExecutionEngine`, and prints `MeasureOutcome` JSON to stdout.
- A `pnpm evaluate` script + a `bin` entry so it runs as a command.
- A golden regression test over the 40 `spike/synthetic` fixtures + one subprocess smoke test.
- Docs: README "Headless evaluation" section (replace the "tracked under E2" stub), a
  MEASURES/ARCHITECTURE note, a JOURNAL entry; reopen/reference #72.

Out of scope (YAGNI / explicitly de-scoped):
- Runtime YAML loader replacing the build-time codegen + `MEASURES` registry.
- Measure selection by YAML file path (id-only).
- Batch/cohort evaluation, an HTTP endpoint, value-set resolution changes, multi-patient bundles.

## 4) Design

### 4.1 Components & boundary

One new file: **`backend-ts/src/engine/cli/evaluate-measure-cli.ts`** (mirrors the Java
`engine.cli` boundary). Responsibilities are I/O + orchestration only — it does **not** evaluate:

- `parseArgs(argv: string[]): CliArgs` — pure; returns `{ patient, measure, date?, pretty }` or
  throws `CliUsageError` with a usage string.
- `run(argv: string[]): Promise<MeasureOutcome>` — the testable core: parse args, read+JSON-parse
  the bundle file, construct `CqlExecutionEngine`, `await engine.evaluate(...)`, return the outcome.
  Reused directly by the in-process golden test.
- `main(argv)` — wraps `run`: prints `JSON.stringify(outcome, null, pretty ? 2 : 0)` to stdout,
  exits `0`; on any thrown error prints a one-line message to **stderr** and exits non-zero.
- A standard `import.meta`-main guard so importing the module (in tests) does not execute `main`.

```
argv → parseArgs → read bundle JSON → CqlExecutionEngine.evaluate → MeasureOutcome → stdout JSON
```

### 4.2 CLI contract

- **Invocation:** `pnpm evaluate --patient ./bundle.json --measure audiogram [--date 2026-06-18] [--pretty]`
- **Output (stdout, success):** the `MeasureOutcome` JSON (compact by default; indented with `--pretty`).
- **`--date`:** optional; defaults to today (UTC, `YYYY-MM-DD`). Pins `Now()`/`Today()` + the
  Measurement Period inside the engine (the engine already applies `periodMonths`).
- **Exit codes:** `0` success; non-zero on usage error, unreadable/!JSON bundle, unknown measure,
  or "no patient in bundle." stdout stays clean (errors go to stderr) so `... | jq` is safe.

### 4.3 Packaging

- `package.json` → `scripts.evaluate`: `"tsx src/engine/cli/evaluate-measure-cli.ts"` (matches the
  repo's tsx-based `dev`/`start`; no build step).
- `package.json` → `bin`: `{ "workwell-evaluate": "src/engine/cli/evaluate-measure-cli.ts" }` with a
  `#!/usr/bin/env -S npx tsx` shebang (or documented `pnpm evaluate` usage) so it is runnable as a
  named command without a compile step.

### 4.4 Error handling

All failure modes surface as a clear stderr line + non-zero exit; none print partial stdout:
missing/!exist `--patient` or `--measure`, malformed JSON bundle, `unknown measure '<id>'`
(thrown by the engine), and "no patient in bundle to evaluate" (thrown by the engine). `parseArgs`
emits a usage string listing the flags.

## 5) Testing

**`backend-ts/src/engine/cli/evaluate-measure-cli.test.ts`** (node test runner + tsx, matching the
repo's `test` script glob):

1. **Golden regression (in-process):** for each `spike/synthetic/<measureId>/<scenario>.json`,
   call `run([...])` and assert `outcome` equals the scenario's expected bucket. Mapping:
   `present_recent → COMPLIANT`, `present_old → OVERDUE`, `missing → MISSING_DATA`,
   `excluded → EXCLUDED` (per-measure exceptions encoded in a small table where a measure's CQL
   differs — e.g. flu/CMS122 have no DUE_SOON and `present_old` semantics vary; the table is the
   single source the test reads, derived from the existing spike parity results). Pin `--date` so
   recency math is deterministic.
2. **Arg/output contract:** `parseArgs` happy-path + each error path; `--pretty` indents; compact is
   default; stdout JSON parses back to the `MeasureOutcome` shape.
3. **Subprocess smoke (1 case):** spawn the actual CLI (`tsx evaluate-measure-cli.ts ...`) for one
   fixture, assert exit `0` and stdout parses to the expected outcome — proves the wiring + shebang.
4. **Error exit:** one bad-input invocation asserts non-zero exit + stderr message + empty stdout.

The golden test reuses the existing `spike/synthetic` corpus rather than authoring new fixtures, so
it inherits the proven Java-parity scenarios. If a fixture's expected bucket is ambiguous, the test
table makes the expectation explicit (ambiguity resolved in favor of the documented spike result).

## 6) Acceptance criteria

- `pnpm evaluate --patient <file> --measure <id>` prints a valid `MeasureOutcome` JSON; bad input
  exits non-zero with a stderr message and clean stdout.
- Golden regression passes for all 10 measures across the available `spike/synthetic` scenarios.
- `pnpm typecheck` + `pnpm test` green; no new runtime dependency.
- README "Headless evaluation" section documents real invocation (replacing the stub); MEASURES /
  ARCHITECTURE note + JOURNAL entry added; #72 reopened/referenced.

## 7) Risks / open points

- **Fixture↔bucket mapping:** scenario filenames imply buckets but a few measures (flu, CMS122) lack
  DUE_SOON and treat `present_old` differently. Mitigation: an explicit expected-outcome table in the
  test, seeded from the spike's known parity output — not inferred from filenames alone. (Verified
  during implementation by first running the engine over each fixture and snapshotting, then locking.)
- **`bin` shebang on Windows:** the repo runs via `tsx`; the `pnpm evaluate` script is the primary,
  portable entry. The `bin` is a convenience; if the shebang proves fiddly cross-platform, the `bin`
  can point at a tiny compiled launcher or be dropped without affecting the core deliverable.
