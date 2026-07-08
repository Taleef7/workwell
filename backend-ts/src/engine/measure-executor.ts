/**
 * The MeasureExecutor seam — the E9 (#78) architectural fork made concrete (ADR-025, advancing ADR-014 /
 * ADR-017). Measure execution is PLUGGABLE behind one port; the FHIR-native executor is the DEFAULT and the
 * correctness oracle, and a SQL-pushdown executor is a future, per-measure, PARITY-GATED opt-in.
 *
 *   - Option A (built, default): `fhirNativeExecutor` — adapt data into a FHIR bundle, evaluate with the
 *     existing JVM-free CQL→ELM engine. Full eCQM fidelity; the sole source of truth for `Outcome Status`
 *     (ADR-008). This is exactly the engine the run pipeline + ingress already use — a MeasureExecutor IS
 *     an `EvaluateMeasureBinding`, so it plugs into `evaluateBundle`'s `opts.engine` seam with no new
 *     plumbing and changes no outcome.
 *   - Option B (INERT stub, research-grade): `sqlPushdownExecutor` — run a measure as SQL inside WebChart's
 *     MariaDB ("run where the data lives"). NOT built: general CQL→SQL (interval/temporal algebra, FHIRPath,
 *     value-set expansion, 3-valued logic) does not map to portable SQL. It is inert-unless-built (mirrors
 *     the inert `webChartDataSource`): it constructs, but `evaluate` throws. Any future SQL executor must
 *     pass GOLDEN PARITY against the FHIR-native oracle, per measure, before it is allowed to serve.
 *   - Option C (this seam): the hybrid — one selection point, FHIR-native as default + oracle, SQL-pushdown
 *     as an opt-in per-measure path. `resolveMeasureExecutor(env)` mirrors resolveDataSource/resolveForecaster.
 *
 * Descriptive posture (ADR-008): the executor decides HOW a measure is computed, never that AI/heuristics
 * set compliance — CQL `Outcome Status` stays authoritative on every path. NO DB, NO node:fs here — this
 * stays portable across every @mieweb/cloud target.
 */
import { CqlExecutionEngine } from "./cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding, EvaluateMeasureInput, MeasureOutcome } from "./evaluate-measure.ts";

/** Diagnostic tag for the built-in executors. Extensible (a future executor can carry its own kind). */
export type MeasureExecutorKind = "fhir-native" | "sql-pushdown" | (string & {});

/**
 * A pluggable measure-execution strategy. It extends `EvaluateMeasureBinding` (the headless
 * patient+measure → outcome contract), so any executor is directly injectable into `evaluateBundle` /
 * `evaluateBatch` (`opts.engine`) and the run pipeline. The `kind` tag is diagnostic only.
 */
export interface MeasureExecutor extends EvaluateMeasureBinding {
  readonly kind: MeasureExecutorKind;
}

// Lazily-created shared FHIR-native engine — constructing it loads FHIRHelpers ELM once. It is the same
// engine CLASS `evaluateBundle` uses (a distinct instance), so the executor default is the identical
// evaluation path — no second evaluator. Callers that need VSAC resolution pass an `engineForEnv(env)`
// engine (see `fhirNativeExecutor` / `resolveMeasureExecutor` `engine` param).
let sharedEngine: EvaluateMeasureBinding | undefined;

/**
 * The default executor (Option A): evaluate via the existing CQL→ELM engine. Optionally inject a binding
 * (tests, or an env-built engine with a VSAC resolver via `engineForEnv`); defaults to a shared engine.
 */
export function fhirNativeExecutor(engine?: EvaluateMeasureBinding): MeasureExecutor {
  return {
    kind: "fhir-native",
    evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome> {
      return (engine ?? (sharedEngine ??= new CqlExecutionEngine())).evaluate(input);
    },
  };
}

/**
 * The SQL-pushdown executor (Option B) — an INERT stub. It constructs (so the seam is fully wired and the
 * selection is testable) but rejects on use: general CQL→SQL is research-grade and not built (ADR-025). A
 * real implementation must be scoped to a narrow measure subset (existence/recency/simple counts) and pass
 * golden parity against `fhirNativeExecutor` before it may serve.
 */
export function sqlPushdownExecutor(): MeasureExecutor {
  return {
    kind: "sql-pushdown",
    evaluate(_input: EvaluateMeasureInput): Promise<MeasureOutcome> {
      return Promise.reject(
        new Error(
          "SQL-pushdown measure executor is not built — E9 Option B (CQL→SQL) is research-grade (ADR-025). " +
            "Use the FHIR-native default; a future SQL executor must pass golden parity vs it, per measure, " +
            "before it is allowed to serve.",
        ),
      );
    },
  };
}

export interface MeasureExecutorEnv {
  /** "fhir-native" (default) | "sql-pushdown". Unknown/blank → the FHIR-native default. */
  WORKWELL_MEASURE_EXECUTOR?: string;
}

/**
 * Config-driven executor selection (mirrors resolveDataSource/resolveForecaster/resolveChannel): FHIR-native
 * is the default and the correctness oracle; the SQL-pushdown executor is selected only on an explicit
 * `WORKWELL_MEASURE_EXECUTOR=sql-pushdown` opt-in — and, being an inert stub, it rejects on use (not on
 * resolve), failing loudly rather than silently. So the deployed default is byte-identical to today.
 */
export function resolveMeasureExecutor(env: MeasureExecutorEnv, engine?: EvaluateMeasureBinding): MeasureExecutor {
  const choice = (env.WORKWELL_MEASURE_EXECUTOR ?? "").trim();
  if (choice === "sql-pushdown") return sqlPushdownExecutor();
  return fhirNativeExecutor(engine);
}
