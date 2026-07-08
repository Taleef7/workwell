/**
 * Batch live-evaluation of the mhn ("MetroHealth Network") population-scale tenant (#185 E13 PR-2,
 * real-evaluation successor to backfill-scale.ts). Instead of FABRICATING outcome buckets from a
 * deterministic index (backfill-scale.ts), this streams each subject through the REAL CQL engine:
 * per subject × every runnable measure it builds an evaluatable FHIR bundle (via the injected
 * `ScaleSubjectGenerator`), evaluates it, and writes the engine's actual `Outcome Status`.
 *
 * The outcomes are still keyed by the existing `mhn|Lxx|Pxx|n` subject_id encoding, so the rollup's
 * bounded `aggregateScaleRun` SQL is untouched. Per-measure MEASURE runs, `triggered_by='seed:scale'`,
 * RUNNING→finalize, chunked `recordOutcomes`, per-measure idempotency (skip measures with an existing
 * COMPLETED seed:scale run), audited (SCALE_POPULATION_EVALUATED). Owner-run on-demand — NOT on deploy.
 *
 * Bounded memory: the loop is SUBJECT-MAJOR and buffers only ONE chunk of outcomes at a time (across
 * all measures for the chunk's subjects), flushing per chunk. All per-measure runs are created UP FRONT
 * (a subject-major loop writes to every run's id as it goes), then finalized + audited at the end.
 *
 * ROLLBACK (reversible) — delete tagged outcomes THEN runs (schema-qualify on the Pg ceiling):
 *   DELETE FROM workwell_spike.outcomes
 *     WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
 *   DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, RecordOutcomeInput } from "../stores/outcome-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { complianceRate } from "./compliance-rates.ts";
import { encodeScaleSubject, SCALE_LOCATIONS, scaleProvidersFor } from "../engine/synthetic/scale-structure.ts";
import { evaluateBundle } from "../engine/ingress/evaluate-bundle.ts";
import { targetForIndex, type ScaleSubjectGenerator } from "./scale-generator.ts";

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

  // Whole-batch idempotency (resumable): skip any measure that ALREADY has a COMPLETED seed:scale run.
  // Scan cap: `listRuns(100_000)` — ample for any realistic instance (runs number in the hundreds/low
  // thousands), and the same window backfill-scale.ts uses. Known limitation at extreme run-history
  // volumes (a COMPLETED seed:scale run older than the newest 100k would be missed → re-seed); the future
  // fix is a targeted "exists COMPLETED seed:scale run for measure X" store query rather than a full scan.
  // Runs are finalized only in the trailing loop AFTER the whole evaluation phase, so a crash during
  // the bulk evaluation leaves NO COMPLETED runs — a resume then re-seeds every measure (not per-measure
  // like backfill-scale.ts, which finalized inside its per-measure loop). Only COMPLETED counts.
  // NOTE: a stranded RUNNING run from a crashed prior invocation is NOT auto-swept — `failStuckRuns`
  // deliberately excludes `seed:%` runs (Fable M7) — so its already-written outcomes linger under a dead
  // run id (a resume mints new run ids and re-writes everything, latest-wins in the COMPLETED-only rollup).
  // At 120k a late crash can orphan up to |measures| × N rows; roll the crashed run back (the
  // delete-tagged-outcomes-then-runs SQL in DEPLOY.md) before resuming to avoid storage bloat.
  const seededMeasures = new Set(
    (await deps.runStore.listRuns(100_000))
      .filter((r) => r.triggeredBy === SCALE_TRIGGER && r.status === "COMPLETED" && r.scopeId)
      .map((r) => r.scopeId as string),
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
      requestedScope: { measureId, evaluationDate: args.asOf, scalePopulation: true },
      measurementPeriodStart: periodStart,
      measurementPeriodEnd: periodEnd,
    });
    runIdByMeasure.set(measureId, run.id);
    rateByMeasure.set(measureId, complianceRate(MEASURE_BINDINGS[measureId]!.rateKey));
  }

  let outcomesCreated = 0;
  // SUBJECT-MAJOR, chunked. Only the current chunk's outcomes (across all measures) are buffered.
  for (let off = 0; off < args.subjects; off += chunk) {
    const end = Math.min(off + chunk, args.subjects);
    const buffer: RecordOutcomeInput[] = [];
    for (let i = off; i < end; i++) {
      const pair = PROVIDER_PAIRS[i % PROVIDER_PAIRS.length]!;
      const subjectId = encodeScaleSubject(pair.li, pair.pi, i);
      for (const measureId of todo) {
        const target = targetForIndex(i, args.subjects, rateByMeasure.get(measureId)!);
        // Per-(subject, measure) error isolation (ARCHITECTURE §6 / DATA_MODEL §5): one evaluation
        // failure must NOT abort the batch — the failed subject is persisted as MISSING_DATA with
        // evaluation-error evidence and the run still finalizes COMPLETED, mirroring the run pipeline.
        let status: string;
        let evidence: unknown;
        try {
          const bundle = deps.generator.bundleFor(subjectId, measureId, target, args.asOf);
          const outcome = await evaluateBundle(bundle, measureId, { evaluationDate: args.asOf });
          status = outcome.outcome;
          evidence = args.trimEvidence ? { scale: true } : outcome.evidence;
        } catch (e) {
          status = "MISSING_DATA";
          evidence = { evaluationError: "CQL engine failure", message: e instanceof Error ? e.message : String(e) };
        }
        buffer.push({
          runId: runIdByMeasure.get(measureId)!,
          subjectId,
          measureId,
          evaluationPeriod: args.asOf,
          status,
          evaluatedAt: completedAt,
          evidence,
        });
      }
    }
    await deps.outcomeStore.recordOutcomes(buffer);
    outcomesCreated += buffer.length;
    // One progress line per chunk (~1.68M sequential evals at 120k otherwise runs silently).
    console.log(`[batch:scale] evaluated ${end}/${args.subjects} subjects`);
  }

  // Finalize + audit each run (every state change is audited, CLAUDE.md). COMPLETED status and the
  // audit event are written together so the idempotency source (COMPLETED runs) is always in sync.
  for (const measureId of todo) {
    const runId = runIdByMeasure.get(measureId)!;
    await deps.runStore.finalizeRun(runId, "COMPLETED");
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
  }

  return { skipped: false, runsCreated: todo.length, outcomesCreated, subjects: args.subjects };
}
