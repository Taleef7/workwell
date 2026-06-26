/**
 * DB-less library entry for evaluating a JSON/FHIR object — and a "bucket" of them — against a
 * measure (#184 / E12, FHIR-native-first). A thin shell over CqlExecutionEngine: NO DB and NO
 * node:fs, so it stays portable across every @mieweb/cloud target (Workers included). File I/O
 * lives only at the CLI edge. The core engine is untouched.
 */
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";
import { MEASURES } from "../cql/measure-registry.ts";
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
 *
 * An unknown `measureId` is a global caller/config error, NOT per-bundle data — so it throws ONCE,
 * up front (fail-fast), rather than degrading into one failed item per bundle (and an empty bucket
 * with a bad measure rightly fails instead of reporting success). This matches the single-bundle path.
 */
export async function evaluateBatch(
  bundles: unknown[],
  measureId: string,
  opts?: EvaluateBundleOptions,
): Promise<BatchResult> {
  if (!MEASURES[measureId]) throw new Error(`unknown measure '${measureId}'`);
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
