# E12 — Pluggable Data Adapters — Design

**Epic:** E12 (#184) — Pluggable data adapters: WebChart/SQL in, DB-less JSON-bucket in
**Date:** 2026-06-26
**Status:** Design (PR-1 scoped for implementation; PR-2 documented, deferred)
**Author:** Taleef (via Claude Code, autonomous)
**Depends on:** the E9 (#78) fork decision — recorded below.

---

## 1. Context & problem

The evaluation engine (`CqlExecutionEngine`, #106 / E1) is already data-source-agnostic at its
core: `evaluate({ measureId, patientBundle, evaluationDate })` runs committed ELM (JVM-free) against
**any** FHIR R4 bundle and returns a `MeasureOutcome` — no database required. The headless CLI (#72 /
E2) proves this end-to-end for a single JSON bundle (`pnpm evaluate --patient bundle.json --measure
audiogram`).

What does **not** yet exist is the **ingress seam** Doug asked for on June 15:
- *"feed a JSON bucket/object so it can work without postgres"* — a documented **library** entry (not
  just a CLI) and a **batch** path over many bundles (a "bucket"), with no DB dependency.
- *"use SQL that uses the schemas MIE implements itself"* — a **WebChart/MariaDB → FHIR** adapter that
  reads MIE's own schema and feeds the same engine unchanged.
- A **config-driven** way to select which ingress is active, leaving the core engine untouched.

E12 builds that pluggable data-ingress seam. The engine stays exactly as-is; adapters sit *in front*
of it, converting a data source into FHIR bundles the engine already understands.

## 2. The E9 (#78) fork decision (recorded here)

E12's issue states it "realizes the E9 (#78) decision's FHIR-native-first path." E9 is a decision
memo (FHIR-native adapter vs CQL→SQL transpile vs hybrid). **Decision recorded for E12:**

> **FHIR-native-first.** Adapters convert source data (JSON object/bucket today; WebChart/MariaDB
> later) into FHIR R4 bundles that feed the existing CQF/cql-execution engine **unchanged**. We do
> **not** transpile CQL→SQL. Rationale: (a) the FHIR-native engine is already built, parity-proven,
> and JVM-free; (b) CQL→SQL transpilation is research-grade and high-risk (Doug Q2); (c) an adapter
> seam is reversible and incremental — a CQL→SQL executor could later slot behind the same port
> without re-deciding now. CQL `Outcome Status` remains the sole compliance authority (ADR-008).

A standalone E9 memo can be written later; this section is the operative decision E12 proceeds on.

## 3. Goals & acceptance (from #184)

- **(a)** A data adapter reads from a **WebChart-shaped SQL schema** (documented mapping;
  simulated/fixture until real access) → FHIR → engine, unchanged.
- **(b)** A **JSON-bucket ingress**: evaluate a plain JSON/FHIR object — and a collection of them —
  with **zero Postgres**, as a reusable library entry (extends the headless CLI/library).
- **(c)** Adapter selection is **config-driven** (mirrors the floor/ceiling + inert-unless-configured
  pattern); the **core engine is untouched**.

**Non-goals (YAGNI):** CQL→SQL transpilation; a live MariaDB driver dependency; persisting adapter
output to the DB; any change to `CqlExecutionEngine`'s evaluation logic; a UI (this is a
library/CLI-level capability). Writing results back to a bucket/EH is out of scope.

## 4. Decomposition — two PRs

| PR | Scope | Risk | Delivers |
|----|-------|------|----------|
| **PR-1** (this design, implement now) | The `PatientDataSource` port; the **JSON-bucket adapter** (single + batch, DB-less library entry); `resolveDataSource(env, …)` config selection; an **inert `webChartDataSource` stub** (inert-unless-configured); CLI refactor to reuse the shared library entry. Tests + docs. | Low — mostly formalizes/extends proven code; no schema, no new deps. | (b) fully, (c) fully, (a) at the seam (inert stub). |
| **PR-2** (documented, deferred) | WebChart/MariaDB **depth**: a documented WebChart→FHIR schema mapping + a **fixture-backed** adapter that reads a WebChart-shaped schema and builds FHIR. Live MariaDB driver stays a deferred, approval-gated drop-in behind the same port. | Higher — greenfield mapping; needs a real schema reference from MIE. | (a) for real. |

This keeps PR-1 clean and high-leverage and isolates the greenfield research into PR-2.

## 5. Architecture (PR-1)

A new module `backend-ts/src/engine/ingress/` (mirrors the existing `engine/` sub-areas). It sits
*above* `CqlExecutionEngine` and never touches it.

### 5.1 The port — `PatientDataSource`
A source of patient FHIR bundles for evaluation — the pluggable data ingress.

```ts
export interface PatientDataSource {
  /** Diagnostic tag — "json" | "webchart". */
  readonly kind: string;
  /** The bundles ("bucket") to evaluate. DB-less for the JSON source. */
  loadBundles(): Promise<unknown[]>;
}
```

One method, one responsibility: "give me the FHIR bundles to evaluate." The engine derives the
subject id from each bundle (its existing behavior), so the source need only yield bundles.

### 5.2 The library entry (DB-less) — `evaluateBundle` / `evaluateBatch`
The documented public "JSON object → outcome" surface, a thin shell over `CqlExecutionEngine` (no DB,
no `node:fs` — so it stays portable across every `@mieweb/cloud` target, Workers included; file I/O
lives only at the CLI edge):

```ts
// Single object → outcome. Formalizes what the CLI does inline today.
export function evaluateBundle(
  bundle: unknown, measureId: string, opts?: { evaluationDate?: string; engine?: EvaluateMeasureBinding },
): Promise<MeasureOutcome>;

// A "bucket" of objects → per-bundle results, with per-item error isolation
// (one malformed/empty bundle does NOT abort the batch).
export function evaluateBatch(
  bundles: unknown[], measureId: string, opts?: { evaluationDate?: string; engine?: EvaluateMeasureBinding },
): Promise<BatchResult>;

export interface BatchItemResult {
  index: number;
  ok: boolean;
  outcome?: MeasureOutcome;   // present when ok
  error?: string;             // present when !ok
}
export interface BatchResult {
  measureId: string;
  evaluationDate: string;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
}
```

`evaluateSource(source, measureId, opts)` is sugar: `evaluateBatch(await source.loadBundles(), …)`.

### 5.3 The JSON-bucket adapter — `jsonBucketDataSource`
The default impl, fully in-memory (already-parsed JSON):

```ts
// Accepts one bundle or an array ("bucket") of bundles.
export function jsonBucketDataSource(input: unknown | unknown[]): PatientDataSource;
```

### 5.4 The inert WebChart stub — `webChartDataSource`
Mirrors the established inert-unless-configured stubs (`iceForecaster`, `ehStandingOrderProvider`,
`dataChaserChannel`): selected only when both `WORKWELL_WEBCHART_*` env vars are set; until PR-2 wires
it, `loadBundles()` throws a clear "WebChart adapter not yet wired (E12 PR-2)" error. No driver dep.

### 5.5 Config-driven selection — `resolveDataSource`
Mirrors `resolveForecaster(env)` / `resolveChannel(type, env)`:

```ts
export interface DataSourceEnv {
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;   // (or DSN — finalized in PR-2)
}
// JSON is the default ingress; WebChart selected only when both env vars are set.
export function resolveDataSource(env: DataSourceEnv, jsonInput?: unknown | unknown[]): PatientDataSource;
```

When WebChart env is configured → `webChartDataSource(cfg)` (inert until PR-2). Otherwise →
`jsonBucketDataSource(jsonInput)` (the JSON default; the caller supplies the bundles, which is
inherent to JSON ingress). Default-is-JSON, safe, no accidental external reads.

### 5.6 CLI refactor (small, DRY)
`engine/cli/evaluate-measure-cli.ts` currently parses+reads+`new CqlExecutionEngine().evaluate(...)`
inline. Refactor its `evaluate()` to call the shared `evaluateBundle(...)` library entry — one
evaluation path, no behavior change. (A `--bucket` batch CLI flag is a possible follow-up, not PR-1.)

## 6. Data flow (PR-1)

```
JSON object/array (in memory)
  └─ jsonBucketDataSource(input).loadBundles()  ──►  evaluateBatch(bundles, measureId, {date})
        (or resolveDataSource(env, input) when                │  per-bundle, error-isolated
         config might select WebChart later)                  ▼
                                                   CqlExecutionEngine.evaluate(  ← UNCHANGED
                                                     { measureId, patientBundle, evaluationDate })
                                                              │
                                                              ▼
                                                   MeasureOutcome[]  (BatchResult)
```

No DB, no `node:fs` in the library path. The CLI adds file reads at the edge only.

## 7. Error handling

- **Batch isolation:** `evaluateBatch` wraps each `engine.evaluate(...)` in try/catch → a
  `BatchItemResult { ok:false, error }` for that index; the batch always resolves with one result per
  input. A single bad bundle (malformed, no Patient, unknown structure) never aborts the rest.
- **Unknown measure:** surfaced once up front (the engine throws `unknown measure '<id>'`);
  `evaluateBundle` propagates it (it's a caller error, not per-bundle).
- **WebChart stub:** `loadBundles()` throws a clear, documented "not yet wired (PR-2)" error.
- **`resolveDataSource`:** never throws on selection; trims env like the sibling resolvers.

## 8. Testing (PR-1)

- `evaluateBundle` parity: a synthetic single bundle yields the **same** `MeasureOutcome` as the CLI
  path / the engine directly (reuse a `spike/synthetic` fixture; assert against the golden bucket).
- `evaluateBatch`: N bundles → N results; mixed valid + invalid → `succeeded`/`failed` counts correct
  and the valid ones still produce outcomes (error isolation proven).
- `jsonBucketDataSource`: single object vs array both `loadBundles()` to the right length.
- `resolveDataSource`: JSON by default; WebChart selected only when both env vars set; the WebChart
  stub's `loadBundles()` throws the documented error.
- CLI regression: the existing CLI tests stay green after the refactor (same outcomes, same exit
  codes) — proves the refactor is behavior-preserving.

## 9. File structure (PR-1)

```
backend-ts/src/engine/ingress/
  data-source.ts            # PatientDataSource port + jsonBucketDataSource + webChartDataSource stub + resolveDataSource
  evaluate-bundle.ts        # evaluateBundle / evaluateBatch / evaluateSource (DB-less library entry)
  index.ts                  # public re-exports
  data-source.test.ts
  evaluate-bundle.test.ts
backend-ts/src/engine/cli/evaluate-measure-cli.ts   # refactor evaluate() to use evaluateBundle (DRY)
```

Docs: `docs/ARCHITECTURE.md` (§3 engine.ingress boundary + §7 a library-entry note), `docs/JOURNAL.md`,
a `DECISIONS.md` ADR recording the E9 FHIR-native-first fork + the E12 adapter seam. README/MEASURES
get a short "DB-less library evaluation" note. **No schema, no new deps.**

## 10. Risks & mitigations

- **Over-abstraction (one real impl):** mitigated — the port + selection + inert stub IS acceptance
  (c), and exactly mirrors three shipped precedents (ICE/EH/DataChaser); not speculative.
- **Redundancy with the CLI:** mitigated — the CLI is refactored to *reuse* the new library entry, so
  there's one evaluation path; the new value is the library surface + batch ("bucket") + the port.
- **PR-2 needs a real WebChart schema:** flagged — PR-2's documented mapping needs a schema reference
  from MIE; the inert stub keeps PR-1 unblocked and the seam ready.
- **`loadBundles()` is eager (`Promise<unknown[]>`):** fine for the JSON bucket (demo scale), but a real
  WebChart adapter over a full patient population would materialize every bundle in memory before
  `evaluateBatch` iterates. **PR-2 decision point:** if streaming large cohorts is needed, change the port
  to `AsyncIterable<unknown>` (and add a streaming `evaluateSource`) — a deliberate, scoped port change,
  not a surprise. Recorded here so PR-1's eager shape is a conscious YAGNI choice.

## 11. Out of scope (explicit)

CQL→SQL transpile; live MariaDB driver; result persistence; engine changes; UI; writing back to a
bucket/EH. All deferred or rejected per §2/§3.
