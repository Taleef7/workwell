/**
 * Per-call timing for the run pipeline's synchronous phases (#563).
 *
 * #563 recorded that during the 90-minute nightly recompute, `GET /api/version` — which opens no
 * database connection and therefore cannot be waiting for one — answered in 13.8 s and 22.0 s
 * against 0.20 s quiet. That rules OUT pool starvation (the failure #560 fixed) and leaves two
 * readings that cannot be told apart from outside the container: our own event loop blocked by
 * synchronous work, or the host pausing a memory-pressured container.
 *
 * This module is the cheapest instrument that can settle the first reading, and it is deliberately
 * the whole of the first step. The repo's own committed figures already make it the favourite:
 * `wiring/official-executor-adapter.ts` records 11-16 ms per subject batched, `evaluateBatch` is
 * awaited ONCE per (chunk x measure) with no yield inside it, and `DEFAULT_RUN_CHUNK_SIZE` is 500 —
 * so one call is 5.5-8 s of uninterrupted synchronous CPU, and the pilot's six routed measures chain
 * six of them through microtask continuations, which do not service I/O in between. That arithmetic
 * is a prior, not a measurement. These lines are the measurement.
 *
 * **`bundleMs` is separated from `evalMs` because they have different fixes.** Bundle construction
 * happens inside the subject FACTORY that `evaluateBatch` invokes, so timing only the await would
 * report one number for two distinct costs: building FHIR bundles (fix: bundle shape, or the source)
 * versus executing CQL (fix: chunk size, or yielding between measures). Timing the factory separately
 * is what makes the resulting number actionable rather than merely alarming.
 *
 * **No threshold and no env knob.** Every call is logged, because the DISTRIBUTION is the deliverable
 * and a threshold hides the baseline the outliers must be compared against. On the pilot that is
 * ~240 lines per nightly (40 chunks x 6 measures), which is nothing. Having no knob also means this
 * introduces no new environment variable, so the `schedulerEnv` threading hazard (`server.ts`, where
 * omitting a key has shipped three times) does not apply to this change at all.
 *
 * **Console, never `appendLog`.** Every `appendLog` is an INSERT through the connection pool
 * (`stores/postgres/run-store-postgres.ts`), and an instrument that writes to the resource it is
 * measuring perturbs the thing it reports. It also has to keep working when the database path is the
 * degraded one, which is the case this exists for.
 */

/** Stable prefix — greppable in MIE container logs (`grep WORKWELL_RUNTIME`). */
export const WORKWELL_RUNTIME_PREFIX = "WORKWELL_RUNTIME";

/**
 * What became of the batch attempt. All three are timed: a call that FAILED after 30 s is as
 * interesting as one that succeeded, and a `not-batchable` measure proves the factory was never
 * invoked rather than that it was free.
 */
export type BatchTimingOutcome = "batched" | "not-batchable" | "failed";

export interface BatchPhaseTiming {
  kind: "evaluateBatch";
  runId: string;
  measureId: string;
  /**
   * Subjects the batch was OFFERED for this (chunk x measure).
   *
   * The factory's list length once the factory has run, and the chunk's count for this measure when
   * it has not — which is the `not-batchable` case, where the executor declined before asking. The
   * two agree today; the distinction is stated because "how many were offered" stays meaningful in
   * both, while "how many bundles were built" would be 0 in one of them and read as a measurement
   * of nothing.
   */
  subjects: number;
  /** Wall time for the whole `evaluateBatch` await, bundles included. */
  batchMs: number;
  /** Of `batchMs`, the part spent inside the subject factory building bundles. */
  bundleMs: number;
  /** `batchMs - bundleMs` — the executor's own time. Never negative. */
  evalMs: number;
  /** `batchMs / subjects`, rounded to 2dp. Zero subjects reports 0 rather than NaN. */
  msPerSubject: number;
  outcome: BatchTimingOutcome;
}

/**
 * One JSON object on one line, never multi-line, so a log shipper keeps the event atomic — the same
 * rule `run/alert-channel.ts` states for `WORKWELL_ALERT`. A DIFFERENT prefix, deliberately:
 * operators grep `WORKWELL_ALERT` as an incident signal, and burying a per-chunk cadence inside it
 * would make that signal useless.
 */
export function formatPhaseTiming(timing: BatchPhaseTiming): string {
  return `${WORKWELL_RUNTIME_PREFIX} ${JSON.stringify(timing)}`;
}

/**
 * Build the record. Pure, so the arithmetic is testable without a clock or a pipeline.
 *
 * `evalMs` is floored at 0: the two measurements are taken by different clocks readings around a
 * nested call, and a scheduler hiccup that made `bundleMs` exceed `batchMs` by a millisecond must not
 * publish a negative duration that a reader would take for a bug in the executor.
 */
export function batchPhaseTiming(input: {
  runId: string;
  measureId: string;
  subjects: number;
  batchMs: number;
  bundleMs: number;
  outcome: BatchTimingOutcome;
}): BatchPhaseTiming {
  const { runId, measureId, subjects, batchMs, bundleMs, outcome } = input;
  return {
    kind: "evaluateBatch",
    runId,
    measureId,
    subjects,
    batchMs,
    bundleMs,
    evalMs: Math.max(0, batchMs - bundleMs),
    msPerSubject: subjects > 0 ? Math.round((batchMs / subjects) * 100) / 100 : 0,
    outcome,
  };
}

/** Where a timing goes. Injected like `alertChannels` is, for the same reason. */
export type PhaseTimingSink = (timing: BatchPhaseTiming) => void;

/**
 * Emit the timing. BEST-EFFORT AND NEVER THROWS, by contract.
 *
 * This is called from inside the run pipeline's chunk loop, where `run-pipeline.ts` records the rule
 * plainly: an observability write must never author an outcome. A `try` rather than a bare `.catch()`
 * because the hazard is a SYNCHRONOUS throw — a closed stdout, or a sink a caller passed that is not
 * a function — and a synchronous throw escapes `.catch()` and would take down a run that had already
 * evaluated its subjects.
 *
 * **The sink is a parameter rather than a global, and that is a testability decision with a reason.**
 * The first version of the integration test captured `console.log` by reassigning it. That test
 * passed alone and FAILED in the full suite, and the failure mode is the point: a global-mutation
 * harness cannot tell "no timing was emitted" from "the run never reached the chunk loop", so it
 * reports a broken instrument when the truth may be a failed run. An injected sink makes the
 * assertion about this module and nothing else.
 */
export function emitPhaseTiming(timing: BatchPhaseTiming, sink?: PhaseTimingSink): void {
  try {
    if (sink) sink(timing);
    else console.log(formatPhaseTiming(timing));
  } catch {
    /* an instrument must never be able to fail the thing it measures */
  }
}
