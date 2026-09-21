/**
 * DB-less library entry for evaluating a JSON/FHIR object — and a "bucket" of them — against a
 * measure (#184 / E12, FHIR-native-first). A thin shell over CqlExecutionEngine: NO DB and NO
 * node:fs, so it stays portable across every @mieweb/cloud target (Workers included). File I/O
 * lives only at the CLI edge. The core engine is untouched.
 */
import { MEASURES } from "../cql/measure-registry.ts";
import type { EvaluateMeasureBinding, MeasureOutcome } from "@work-well/measure-engine";
import { createWorkwellEngine } from "../cql/workwell-engine.ts";

export interface EvaluateBundleOptions {
  /** YYYY-MM-DD; defaults to today (the engine's default for single, resolved explicitly for batch). */
  evaluationDate?: string;
  /** Injectable binding (tests); defaults to a lazily-created shared CqlExecutionEngine. */
  engine?: EvaluateMeasureBinding;
  /**
   * Yield to the event loop after every Nth bundle (#563). Default 1 — after every one. `0` disables
   * it, for a caller that owns the whole process and wants the last 1.5%.
   *
   * Injected rather than read from the environment, because this file is the engine's DB-less shell
   * and the engine takes its configuration from its caller (ADR-059).
   */
  yieldEvery?: number;
}

/**
 * Hand the event loop a turn — a MACROTASK, which is the entire point.
 *
 * `await` on a sync-resolving promise schedules a MICROTASK, and Node drains the whole microtask
 * queue before it ever reaches the poll phase. So the `await engine.evaluate(...)` chain below never
 * lets a pending request be served: measured on this machine at 42 ms/bundle, a 60-bundle batch
 * served **one** request in 2.5 s with a worst latency of 2,534 ms, and `queueMicrotask` changed
 * neither number. That is #563's finding — `GET /api/version`, which opens no database connection
 * and therefore cannot be waiting for one, degrading from 0.2 s to 22 s during a nightly run.
 *
 * `setImmediate` is the better primitive where it exists (worst latency 43.5 ms, +1.5% run time,
 * versus 85.6 ms and +2.4% for the timer) but it does not exist on every `@mieweb/cloud` target —
 * Workers has no `setImmediate` — and the header of this file promises portability. So: the better
 * one on the host we deploy to, a correct one everywhere else.
 */
const yieldToEventLoop = (): Promise<void> =>
  typeof setImmediate === "function"
    ? new Promise<void>((resolve) => setImmediate(resolve))
    : new Promise<void>((resolve) => setTimeout(resolve, 0));

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
  opts?.engine ?? (defaultEngine ??= createWorkwellEngine());

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
  const yieldEvery = opts?.yieldEvery ?? 1;
  for (let index = 0; index < bundles.length; index++) {
    try {
      const outcome = await engine.evaluate({ measureId, patientBundle: bundles[index], evaluationDate });
      results.push({ index, ok: true, outcome });
    } catch (e) {
      results.push({ index, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    // After the push, so a yield never sits between an evaluation and the recording of its result.
    if (yieldEvery > 0 && (index + 1) % yieldEvery === 0 && index + 1 < bundles.length) {
      await yieldToEventLoop();
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { measureId, evaluationDate, total: bundles.length, succeeded, failed: results.length - succeeded, results };
}
