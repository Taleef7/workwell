/**
 * Generated population-scale backfill (#185 E13 PR-2). Writes the mhn ("MetroHealth Network") tenant's
 * ~120k subjects as OUTCOME rows (one COMPLETED MEASURE run per runnable measure, subject_id-encoded,
 * minimal evidence) so the rollup can aggregate 120k in SQL without live CQL evaluation. Deterministic,
 * idempotent (skips if a seed:scale run already exists), audited (SCALE_POPULATION_SEEDED). Owner-run
 * on-demand via the seed:scale CLI — NOT on deploy.
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

export const SCALE_TRIGGER = "seed:scale";
export const SCALE_POPULATION_SEEDED_EVENT = "SCALE_POPULATION_SEEDED";
const DAY_MS = 86_400_000;
const CHUNK = 5_000;

export interface ScaleBackfillDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  auditStore: CaseEventStore;
}
export interface ScaleBackfillArgs {
  subjects: number;
  asOf: string;
}
export interface ScaleBackfillSummary {
  skipped: boolean;
  runsCreated: number;
  outcomesCreated: number;
  subjects: number;
}

/**
 * Deterministic status for subject index `i` of `n` at compliance `rate`: the first round(rate*n) are
 * COMPLIANT, then the remainder cycles the four non-compliant buckets. No randomness — stable across
 * runs (and tenant-proof: the same i always lands in the same bucket).
 */
function statusForIndex(i: number, n: number, rate: number): string {
  const compliant = Math.round(n * rate);
  if (i < compliant) return "COMPLIANT";
  const order = ["OVERDUE", "DUE_SOON", "MISSING_DATA", "EXCLUDED"] as const;
  return order[(i - compliant) % order.length]!;
}

/** The flat (locationIndex, providerIndex) pairs across the scale structure (240 by default). */
const PROVIDER_PAIRS: ReadonlyArray<{ li: number; pi: number }> = SCALE_LOCATIONS.flatMap((loc, li) =>
  scaleProvidersFor(loc.id).map((_p, pi) => ({ li, pi })),
);

export async function backfillScalePopulation(deps: ScaleBackfillDeps, args: ScaleBackfillArgs): Promise<ScaleBackfillSummary> {
  const measureIds = Object.keys(MEASURES);
  // Per-measure idempotency (resumable): skip any measure that ALREADY has a seed:scale run, so a
  // re-run fills only the missing measures (e.g. resuming after a crash mid-seed) and never
  // double-writes. To re-seed with a different --subjects, roll back first (see header).
  // Only treat COMPLETED runs as fully seeded. A run in RUNNING or FAILED status means a prior
  // invocation crashed between createRun and finalizeRun — we must not skip that measure, or the
  // dashboard will aggregate a partial population. The orphaned partial run will be marked FAILED
  // by failStuckRuns after 30 min; the new COMPLETED run then becomes the rollup source.
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

  let runsCreated = 0;
  let outcomesCreated = 0;
  for (const measureId of todo) {
    // Create as RUNNING so a crash before finalizeRun leaves a non-COMPLETED run — the idempotency
    // check above only skips COMPLETED runs, so the next invocation will re-seed this measure.
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
    const rate = complianceRate(MEASURE_BINDINGS[measureId]!.rateKey);
    const inputs: RecordOutcomeInput[] = Array.from({ length: args.subjects }, (_, i) => {
      const pair = PROVIDER_PAIRS[i % PROVIDER_PAIRS.length]!;
      return {
        runId: run.id,
        subjectId: encodeScaleSubject(pair.li, pair.pi, i),
        measureId,
        evaluationPeriod: args.asOf,
        status: statusForIndex(i, args.subjects, rate),
        evaluatedAt: completedAt,
        evidence: { scale: true }, // minimal — generated rows need no expressionResults
      };
    });
    // Chunk the batch insert so a single multi-row INSERT stays within Postgres parameter limits.
    for (let off = 0; off < inputs.length; off += CHUNK) {
      await deps.outcomeStore.recordOutcomes(inputs.slice(off, off + CHUNK));
    }
    // All outcomes written — finalize then audit. The audit (every state change must be audited,
    // CLAUDE.md) marks the run as fully seeded, so audit and COMPLETED status are always in sync.
    await deps.runStore.finalizeRun(run.id, "COMPLETED");
    await deps.auditStore.appendAudit({
      eventType: SCALE_POPULATION_SEEDED_EVENT,
      entityType: "run",
      entityId: run.id,
      actor: SCALE_TRIGGER,
      refRunId: run.id,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { measureId, subjects: args.subjects, asOf: args.asOf },
    });
    runsCreated++;
    outcomesCreated += inputs.length;
  }
  return { skipped: false, runsCreated, outcomesCreated, subjects: args.subjects };
}
