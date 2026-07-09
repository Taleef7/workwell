/**
 * Batch live-evaluation of the mhn ("MetroHealth Network") population-scale tenant (#185 E13 PR-2,
 * real-evaluation successor to backfill-scale.ts). Instead of FABRICATING outcome buckets from a
 * deterministic index (backfill-scale.ts), this streams each subject through the REAL CQL engine:
 * per subject × every runnable measure it builds an evaluatable FHIR bundle (via the injected
 * `ScaleSubjectGenerator`), evaluates it, and writes the engine's actual `Outcome Status`.
 *
 * The outcomes are still keyed by the existing `mhn|Lxx|Pxx|n` subject_id encoding, so the rollup's
 * bounded `aggregateScaleRun` SQL is untouched. Per-measure MEASURE runs, `triggered_by='seed:scale'`
 * with a durable `requestedScope.batchEvaluated=true` marker (distinguishes these from legacy fabricated
 * seed:scale runs, which share the trigger), RUNNING→finalize, chunked `recordOutcomes`, whole-batch
 * idempotency (skip measures with an existing batch-evaluated COMPLETED run; REFUSE over legacy
 * fabricated runs), best-effort audit (SCALE_POPULATION_EVALUATED). Owner-run on-demand — NOT on deploy.
 *
 * Bounded memory: the loop is SUBJECT-MAJOR and buffers only ONE chunk of outcomes at a time (across
 * all measures for the chunk's subjects), flushing per chunk. All per-measure runs are created UP FRONT
 * (a subject-major loop writes to every run's id as it goes), then finalized + audited at the end.
 *
 * PARALLELISM (#256): `args.workers > 1` runs the evaluation through a hand-rolled `node:worker_threads`
 * pool (`scale-eval-pool.ts` + `scale-eval-worker.ts`). Work units are (start, end) SUBJECT-INDEX
 * ranges — never FHIR bundles or cql-execution objects across the thread boundary; each worker
 * regenerates the bundle in-thread from the index and returns plain-JSON rows. The MAIN thread still
 * does every DB write (`recordOutcomes`) + finalize + audit, so idempotency/resume/audit semantics and
 * the `aggregateScaleRun` read path are all UNCHANGED — parallelism only speeds up the evaluate phase.
 * `args.workers <= 1` (the default) is the unchanged single-threaded path (escape hatch + parity
 * baseline). The pool lives ONLY on this batch CLI path — it is unreachable from worker.ts.
 *
 * ROLLBACK (reversible) — delete tagged outcomes THEN runs (schema-qualify on the Pg ceiling):
 *   DELETE FROM workwell_spike.outcomes
 *     WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
 *   DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
 */
import { Worker } from "node:worker_threads";
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, RecordOutcomeInput } from "../stores/outcome-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { complianceRate } from "./compliance-rates.ts";
import { encodeScaleSubject, SCALE_LOCATIONS, scaleProvidersFor } from "../engine/synthetic/scale-structure.ts";
import { evaluateBundle } from "../engine/ingress/evaluate-bundle.ts";
import { targetForIndex, RECONSTRUCTABLE_GENERATOR_KINDS, type ScaleSubjectGenerator } from "./scale-generator.ts";
import { runScaleEvalPool, type WorkerOutcomeRow } from "./scale-eval-pool.ts";

export const SCALE_TRIGGER = "seed:scale";
export const SCALE_EVALUATED_EVENT = "SCALE_POPULATION_EVALUATED";
const DAY_MS = 86_400_000;
const DEFAULT_CHUNK = 500;

export interface ScaleBatchDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  auditStore: CaseEventStore;
  /** Turns (subjectId, measureId, target, evaluationDate) into an evaluatable FHIR bundle. */
  generator: ScaleSubjectGenerator;
}
export interface ScaleBatchArgs {
  subjects: number;
  asOf: string;
  /** Outcomes buffered + flushed per chunk (bounds memory). Defaults to 500. */
  chunkSize?: number;
  /** Persist minimal `{scale:true}` evidence instead of the full engine evidence (keeps rows small). */
  trimEvidence?: boolean;
  /**
   * Worker-pool size (#256). `<= 1` (the default) takes the unchanged single-threaded sequential path
   * — the escape hatch + the parity baseline. `> 1` spawns exactly this many `node:worker_threads`
   * workers, each regenerating bundles from subject indices and evaluating in-thread while the MAIN
   * thread does every DB write. The CLI resolves this against `availableParallelism()`; a caller/test
   * may force an exact count. Confined to this batch CLI path — never reachable from worker.ts.
   */
  workers?: number;
}
export interface ScaleBatchSummary {
  skipped: boolean;
  runsCreated: number;
  outcomesCreated: number;
  subjects: number;
}

/** The flat (locationIndex, providerIndex) pairs across the scale structure (240 by default). */
const PROVIDER_PAIRS: ReadonlyArray<{ li: number; pi: number }> = SCALE_LOCATIONS.flatMap((loc, li) =>
  scaleProvidersFor(loc.id).map((_p, pi) => ({ li, pi })),
);

/**
 * The encoded `mhn|Lxx|Pxx|n` subject id for subject index `i` — the round-robin over provider pairs.
 * Shared by the sequential loop AND the worker (which regenerates subjects from indices), so an index
 * maps to the SAME subject id regardless of which thread evaluates it. Deterministic on index.
 */
export function subjectIdForIndex(i: number): string {
  const pair = PROVIDER_PAIRS[i % PROVIDER_PAIRS.length]!;
  return encodeScaleSubject(pair.li, pair.pi, i);
}

/**
 * Evaluate ONE (subject, measure) pair to a persistable `{status, evidence}` — the single pure unit
 * shared by the sequential path and the worker, so a worker-produced row is byte-identical to a
 * sequential row for the same inputs (the #256 parity guarantee). Per-(subject, measure) error
 * isolation lives here (ARCHITECTURE §6 / DATA_MODEL §5): an evaluation failure becomes MISSING_DATA
 * with evaluation-error evidence and never propagates, mirroring the run pipeline.
 */
export async function evaluateScaleSubjectMeasure(
  generator: ScaleSubjectGenerator,
  subjectId: string,
  measureId: string,
  target: TargetOutcome,
  asOf: string,
  trimEvidence: boolean,
): Promise<{ status: string; evidence: unknown }> {
  try {
    const bundle = generator.bundleFor(subjectId, measureId, target, asOf);
    const outcome = await evaluateBundle(bundle, measureId, { evaluationDate: asOf });
    return { status: outcome.outcome, evidence: trimEvidence ? { scale: true } : outcome.evidence };
  } catch (e) {
    return {
      status: "MISSING_DATA",
      evidence: { evaluationError: "CQL engine failure", message: e instanceof Error ? e.message : String(e) },
    };
  }
}

export async function batchEvaluateScalePopulation(
  deps: ScaleBatchDeps,
  args: ScaleBatchArgs,
): Promise<ScaleBatchSummary> {
  const measureIds = Object.keys(MEASURES);
  const chunk = args.chunkSize ?? DEFAULT_CHUNK;
  // Guard the exported API: a non-positive chunk would dead-loop the `off += chunk` stream (off never
  // advances at 0, goes backward when negative), and a non-positive subject count is a caller error.
  if (!Number.isInteger(chunk) || chunk < 1) throw new Error(`chunkSize must be a positive integer, got ${args.chunkSize}`);
  if (!Number.isInteger(args.subjects) || args.subjects < 1) throw new Error(`subjects must be a positive integer, got ${args.subjects}`);

  // Both the fabricated backfill (backfill-scale.ts) and this evaluate path write
  // triggered_by='seed:scale' (the rollup + rollback SQL key on that value — left UNCHANGED). To tell
  // the two apart, evaluate runs carry a durable `requestedScope.batchEvaluated=true` marker (listRuns
  // projects requested_scope_json on both the floor + ceiling, so it survives the round-trip). We must
  // NOT mix them: a legacy FABRICATED COMPLETED seed:scale run would otherwise (a) be silently treated
  // as "already seeded" here — so `--mode evaluate` would no-op on the live DB, which HAS fabricated
  // runs — and (b) leave the rollup an ambiguous latest run per measure.
  //
  // Scan cap: `listRuns(100_000)` — ample for any realistic instance (runs number in the hundreds/low
  // thousands), and the same window backfill-scale.ts uses. Known limitation at extreme run-history
  // volumes (a COMPLETED seed:scale run older than the newest 100k would be missed → re-seed); the future
  // fix is a targeted "exists COMPLETED seed:scale run for measure X" store query rather than a full scan.
  const completedScaleRuns = (await deps.runStore.listRuns(100_000)).filter(
    (r) => r.triggeredBy === SCALE_TRIGGER && r.status === "COMPLETED" && r.scopeId,
  );
  // Refuse LOUDLY over legacy fabricated data (owner-gated — this NEVER auto-deletes): a COMPLETED
  // seed:scale run WITHOUT the batchEvaluated marker is fabricated. Fail so the owner rolls it back
  // first, rather than silently no-opping (or leaving fabricated + evaluated runs ambiguously mixed).
  const legacyFabricated = completedScaleRuns.filter((r) => r.requestedScope?.batchEvaluated !== true);
  if (legacyFabricated.length > 0) {
    throw new Error(
      "Refusing to batch-evaluate the scale tenant: legacy FABRICATED seed:scale runs exist " +
        `(${legacyFabricated.length}). Roll them back first (owner-gated — this never auto-deletes): ` +
        "delete the tagged outcomes, then the runs —\n" +
        "  DELETE FROM workwell_spike.outcomes WHERE run_id IN " +
        "(SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');\n" +
        "  DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';",
    );
  }
  // Whole-batch idempotency (resumable): skip any measure that ALREADY has a BATCH-EVALUATED COMPLETED
  // seed:scale run. Runs are finalized only in the trailing loop AFTER the whole evaluation phase, so a
  // crash during the bulk evaluation leaves NO COMPLETED runs — a resume then re-seeds every measure
  // (not per-measure like backfill-scale.ts, which finalized inside its per-measure loop). Counting only
  // batch-evaluated runs is what makes a crashed evaluate run resume correctly.
  // NOTE: a stranded RUNNING run from a crashed prior invocation is NOT auto-swept — `failStuckRuns`
  // deliberately excludes `seed:%` runs (Fable M7) — so its already-written outcomes linger under a dead
  // run id (a resume mints new run ids and re-writes everything, latest-wins in the COMPLETED-only rollup).
  // At 120k a late crash can orphan up to |measures| × N rows; roll the crashed run back (the
  // delete-tagged-outcomes-then-runs SQL above) before resuming to avoid storage bloat.
  const seededMeasures = new Set(
    completedScaleRuns.filter((r) => r.requestedScope?.batchEvaluated === true).map((r) => r.scopeId as string),
  );
  const todo = measureIds.filter((m) => !seededMeasures.has(m));
  if (todo.length === 0) return { skipped: true, runsCreated: 0, outcomesCreated: 0, subjects: args.subjects };

  const startedMs = new Date(`${args.asOf}T00:00:00.000Z`).getTime();
  const startedAt = new Date(startedMs).toISOString();
  const completedAt = new Date(startedMs + 60_000).toISOString();
  const periodEnd = new Date(startedMs).toISOString();
  const periodStart = new Date(startedMs - 365 * DAY_MS).toISOString();

  // Create every per-measure run UP FRONT (RUNNING). A subject-major loop writes outcomes to all of
  // them as it streams subjects, so all run ids must be live before the loop starts. A crash before
  // finalizeRun leaves non-COMPLETED runs → the idempotency check above re-seeds those measures.
  const runIdByMeasure = new Map<string, string>();
  const rateByMeasure = new Map<string, number>();
  for (const measureId of todo) {
    const run = await deps.runStore.createRun({
      scopeType: "MEASURE",
      scopeId: measureId,
      triggeredBy: SCALE_TRIGGER,
      status: "RUNNING",
      startedAt,
      // batchEvaluated:true is the durable marker that distinguishes a REAL evaluated run from a legacy
      // fabricated one (both share triggered_by='seed:scale'); the idempotency + legacy-refusal above key on it.
      requestedScope: { measureId, evaluationDate: args.asOf, scalePopulation: true, batchEvaluated: true },
      measurementPeriodStart: periodStart,
      measurementPeriodEnd: periodEnd,
    });
    runIdByMeasure.set(measureId, run.id);
    rateByMeasure.set(measureId, complianceRate(MEASURE_BINDINGS[measureId]!.rateKey));
  }

  let outcomesCreated = 0;
  const trimEvidence = args.trimEvidence === true;
  const workers = args.workers ?? 1;

  // The MAIN thread persists every chunk's rows — the sequential path and the worker path both flow
  // through here, so the DB-write side is byte-identical regardless of parallelism (idempotency +
  // audit semantics preserved; the aggregateScaleRun read path is untouched — status only).
  const persistChunk = async (rows: WorkerOutcomeRow[]): Promise<void> => {
    const buffer: RecordOutcomeInput[] = rows.map((row) => ({
      runId: runIdByMeasure.get(row.measureId)!,
      subjectId: row.subjectId,
      measureId: row.measureId,
      evaluationPeriod: args.asOf,
      status: row.status,
      evaluatedAt: completedAt,
      evidence: row.evidence,
    }));
    await deps.outcomeStore.recordOutcomes(buffer);
    outcomesCreated += buffer.length;
  };

  if (workers > 1) {
    // PARALLEL (#256): a hand-rolled pool over node:worker_threads. Work units are (start, end)
    // subject-index ranges; each worker regenerates the bundle IN-THREAD from the index (the generator
    // is deterministic on index) and evaluates every measure, returning plain-JSON rows. The main
    // thread does ALL DB writes via persistChunk (bounded memory: at most poolSize chunks buffered).
    // The generator can't cross the thread boundary, so the worker reconstructs it from `kind` — fail
    // fast if it isn't reconstructable rather than silently degrading every subject to MISSING_DATA.
    if (!RECONSTRUCTABLE_GENERATOR_KINDS.has(deps.generator.kind)) {
      throw new Error(
        `worker pool (workers=${workers}) requires a reconstructable generator kind ` +
          `(${[...RECONSTRUCTABLE_GENERATOR_KINDS].join(" / ")}), got '${deps.generator.kind}'`,
      );
    }
    const workerUrl = new URL("./scale-eval-worker.ts", import.meta.url);
    const workerData = {
      asOf: args.asOf,
      totalSubjects: args.subjects,
      measureIds: todo,
      generatorKind: deps.generator.kind,
      trimEvidence,
      rateByMeasure: Object.fromEntries(rateByMeasure),
    };
    let evaluated = 0;
    await runScaleEvalPool({
      totalSubjects: args.subjects,
      chunkSize: chunk,
      poolSize: workers,
      spawnWorker: () => {
        const w = new Worker(workerUrl, { workerData });
        return {
          postMessage: (m) => w.postMessage(m),
          onMessage: (cb) => w.on("message", cb),
          onError: (cb) => w.on("error", cb),
          onExit: (cb) => w.on("exit", cb),
          terminate: () => void w.terminate(),
        };
      },
      onChunkRows: async (rows) => {
        await persistChunk(rows);
        evaluated = Math.min(evaluated + Math.round(rows.length / todo.length), args.subjects);
        console.log(`[batch:scale] evaluated ~${evaluated}/${args.subjects} subjects (${workers} workers)`);
      },
      // Hard-crash fallback (a chunk whose worker crashed twice): fail its subjects soft to
      // MISSING_DATA, mirroring the per-subject isolation of the in-worker/sequential path.
      buildFallbackRows: (start, end) => {
        const rows: WorkerOutcomeRow[] = [];
        for (let i = start; i < end; i++) {
          const subjectId = subjectIdForIndex(i);
          for (const measureId of todo) {
            rows.push({
              subjectId,
              measureId,
              status: "MISSING_DATA",
              evidence: { evaluationError: "worker crashed", message: "chunk failed after one retry" },
            });
          }
        }
        return rows;
      },
    });
  } else {
    // SEQUENTIAL (default; --workers 1): the unchanged subject-major chunked loop. Only the current
    // chunk's outcomes (across all measures) are buffered.
    for (let off = 0; off < args.subjects; off += chunk) {
      const end = Math.min(off + chunk, args.subjects);
      const rows: WorkerOutcomeRow[] = [];
      for (let i = off; i < end; i++) {
        const subjectId = subjectIdForIndex(i);
        for (const measureId of todo) {
          const target = targetForIndex(i, args.subjects, rateByMeasure.get(measureId)!);
          const { status, evidence } = await evaluateScaleSubjectMeasure(deps.generator, subjectId, measureId, target, args.asOf, trimEvidence);
          rows.push({ subjectId, measureId, status, evidence });
        }
      }
      await persistChunk(rows);
      // One progress line per chunk (~1.68M sequential evals at 120k otherwise runs silently).
      console.log(`[batch:scale] evaluated ${end}/${args.subjects} subjects`);
    }
  }

  // Finalize + audit each run (every state change is audited, CLAUDE.md). Finalize-before-audit, and
  // the audit is BEST-EFFORT — mirrors the run pipeline's Fable-H1 pattern: if `appendAudit` throws, the
  // run is already COMPLETED (so a resume would skip it), so aborting here would strand the remaining
  // runs unfinalized. Instead log a WARN (the audit-ledger gap) and CONTINUE finalizing/auditing the rest.
  for (const measureId of todo) {
    const runId = runIdByMeasure.get(measureId)!;
    await deps.runStore.finalizeRun(runId, "COMPLETED");
    try {
      await deps.auditStore.appendAudit({
        eventType: SCALE_EVALUATED_EVENT,
        entityType: "run",
        entityId: runId,
        actor: SCALE_TRIGGER,
        refRunId: runId,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: { measureId, subjects: args.subjects, asOf: args.asOf, generator: deps.generator.kind },
      });
    } catch (e) {
      console.warn(`[batch:scale] audit append failed for run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { skipped: false, runsCreated: todo.length, outcomesCreated, subjects: args.subjects };
}
