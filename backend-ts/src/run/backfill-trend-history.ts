/**
 * Synthetic TREND HISTORY backfill — writes ~12 weekly BACKDATED `COMPLETED` MEASURE runs per
 * runnable measure so the `/programs` + `/programs/[measureId]` trend charts show a believable,
 * varied compliance line instead of a flat line / "Not enough run history" (design:
 * docs/superpowers/specs/2026-06-20-synthetic-trend-history-design.md).
 *
 * Approach (controlled, idempotent, reversible):
 *   - Each backdated run carries `triggered_by = 'seed:trend-history'` and outcomes tagged
 *     `evidence.seedTrendHistory = true`, so the whole feature is removable. Delete the tagged
 *     OUTCOMES first, then the runs (the `outcomes.run_id` FK is NOT declared ON DELETE CASCADE,
 *     and the Pg ceiling lives in the `workwell_spike` schema — so schema-qualify there):
 *
 *         -- Postgres ceiling (workwell_spike schema):
 *         DELETE FROM workwell_spike.outcomes
 *           WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history');
 *         DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history';
 *
 *     (cases are never written by the backfill — see below.)
 *   - Idempotent + resumable: seeding is tracked PER MEASURE (already-seeded measures are skipped,
 *     missing ones seeded), so an interrupted run can be re-run safely; it's a full no-op only when
 *     every measure is already seeded.
 *   - Efficiency: `deriveExamConfig(binding, target)` + `buildSyntheticBundle` depend only on
 *     (measure, target), NOT on employee identity, so the engine outcome for a given (measure,
 *     target) is identical across employees. We precompute the (measure, target) → outcome map with
 *     11 measures × 5 targets = 55 engine evaluations, then assign all ~13.2k historical outcomes
 *     from the seeded distribution — not one engine call per employee.
 *
 * Invariants preserved: outcomes still come from the CQL engine (the (measure,target)→outcome map);
 * NO schema change (only the optional backdating params over existing columns); the worklist/cases
 * are untouched (this NEVER calls a case-store upsert); the programs OVERVIEW is unaffected — each
 * measure's newest synthetic week is anchored strictly BEFORE that measure's latest real run, and
 * the overview selects max(runStartedAt) per measure, so a seeded point can never become "current".
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, RecordOutcomeInput } from "../stores/outcome-store.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { EMPLOYEES, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig, type TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededDistributionAtRate } from "./distribution.ts";
import { historicalComplianceRate } from "./compliance-rates.ts";
import { isPopulationRun } from "../program/rollup-shared.ts";

/** Trigger marker stamped on every backdated run — the single-statement rollback key. */
export const TREND_HISTORY_TRIGGER = "seed:trend-history";

const DEFAULT_WEEKS = 12;
const DAY_MS = 86_400_000;
const RUNNABLE_MEASURE_IDS = Object.keys(MEASURES);
const TARGETS: TargetOutcome[] = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"];

export interface BackfillTrendHistoryDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  engine: EvaluateMeasureBinding;
  /** Injectable for tests; defaults to the full synthetic directory (~100 employees). */
  employees?: readonly EmployeeProfile[];
}

export interface BackfillTrendHistoryOptions {
  /** Number of weekly points per measure (default 12). */
  weeks?: number;
  /** The newest historical week's anchor date `YYYY-MM-DD` (default today). */
  asOf?: string;
}

export interface BackfillTrendHistorySummary {
  skipped: boolean;
  weeks: number;
  measures: number;
  runsCreated: number;
  outcomesCreated: number;
}

const dayOnly = (iso: string): string => iso.slice(0, 10);

/** Precompute the (measure, target) → outcome status map with one engine eval per pair (55 total). */
async function precomputeOutcomes(
  engine: EvaluateMeasureBinding,
  sample: EmployeeProfile,
  asOf: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const measureId of RUNNABLE_MEASURE_IDS) {
    const binding = MEASURE_BINDINGS[measureId]!;
    for (const target of TARGETS) {
      const config = deriveExamConfig(binding, target);
      const bundle = buildSyntheticBundle(sample, config, asOf);
      const result = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: asOf });
      map.set(`${measureId}|${target}`, result.outcome);
    }
  }
  return map;
}

/**
 * Has THIS measure already been backfilled? Looks for an outcome carrying the `seedTrendHistory`
 * marker (the RunRecord contract doesn't expose triggered_by). Per-measure (not global) so an
 * interrupted backfill is resumable: already-seeded measures are skipped, missing ones are seeded
 * on a rerun (Codex P2 — the old global "first measure" probe could skip the rest after a partial).
 */
async function measureSeeded(outcomeStore: OutcomeStore, measureId: string): Promise<boolean> {
  const rows = await outcomeStore.listOutcomesForMeasure(measureId);
  return rows.some((r) => (r.evidence as { seedTrendHistory?: boolean } | null)?.seedTrendHistory === true);
}

/**
 * The latest REAL population-run `started_at` (ms) for a measure, or null if none. The newest
 * synthetic week is anchored strictly BEFORE this so seeded history never becomes the measure's
 * "current" run — `programOverview` selects `max(runStartedAt)` per measure, so a synthetic point
 * newer than the last real run would hijack the overview KPI (Codex P2). Only called for
 * not-yet-seeded measures, whose existing outcomes are therefore all real.
 */
async function latestRealRunMs(outcomeStore: OutcomeStore, measureId: string): Promise<number | null> {
  const rows = await outcomeStore.listOutcomesWithRun({ measureId });
  let max: number | null = null;
  for (const r of rows) {
    if (!isPopulationRun(r.runScopeType)) continue; // exclude CASE/EMPLOYEE reruns (overview parity)
    const t = Date.parse(r.runStartedAt);
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * Backfill weekly backdated COMPLETED runs (oldest→newest) for every runnable measure so the trend
 * charts show a varied line. Per-measure idempotent (resumable): already-seeded measures are
 * skipped; `skipped:true` only when ALL measures were already seeded. Each measure's newest week is
 * anchored strictly before its latest real run, so the programs OVERVIEW is never hijacked. Never
 * touches the case store.
 */
export async function backfillTrendHistory(
  deps: BackfillTrendHistoryDeps,
  opts: BackfillTrendHistoryOptions = {},
): Promise<BackfillTrendHistorySummary> {
  const employees = deps.employees ?? EMPLOYEES;
  const weeks = Math.max(1, Math.trunc(opts.weeks ?? DEFAULT_WEEKS));
  const asOf = (opts.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const asOfMs = Date.parse(`${asOf}T00:00:00.000Z`);

  // Which measures still need seeding? (per-measure → resume-safe after a partial failure)
  const todo: string[] = [];
  for (const measureId of RUNNABLE_MEASURE_IDS) {
    if (!(await measureSeeded(deps.outcomeStore, measureId))) todo.push(measureId);
  }
  const sample = employees[0];
  if (todo.length === 0 || !sample) {
    return { skipped: todo.length === 0, weeks, measures: RUNNABLE_MEASURE_IDS.length, runsCreated: 0, outcomesCreated: 0 };
  }
  const outcomeByPair = await precomputeOutcomes(deps.engine, sample, asOf);

  let runsCreated = 0;
  let outcomesCreated = 0;

  for (const measureId of todo) {
    const rateKey = MEASURE_BINDINGS[measureId]!.rateKey;
    // Anchor the newest synthetic week strictly BEFORE this measure's latest real run (≥ 1 day),
    // capped at asOf, so seeded history never out-ranks the real current run on the overview. If the
    // measure has no real run yet, anchor at asOf (the seed legitimately populates an empty card).
    const latestReal = await latestRealRunMs(deps.outcomeStore, measureId);
    const anchorMs = latestReal != null ? Math.min(asOfMs, latestReal - DAY_MS) : asOfMs;
    // Oldest → newest so started_at strictly increases (week 0 = oldest, weeks-1 = newest = anchor).
    for (let w = 0; w < weeks; w++) {
      const weeksBack = weeks - 1 - w; // weeks-1 back for the oldest, 0 for the newest (= anchor)
      const startedMs = anchorMs - weeksBack * 7 * DAY_MS;
      const startedAt = new Date(startedMs).toISOString();
      // Completed a minute later — keeps the COMPLETED run's window self-consistent.
      const completedAt = new Date(startedMs + 60_000).toISOString();
      // 365-day measurement window ending at the run's date (mirrors the live run pipeline).
      const periodEnd = new Date(startedMs).toISOString();
      const periodStart = new Date(startedMs - 365 * DAY_MS).toISOString();

      const run = await deps.runStore.createRun({
        scopeType: "MEASURE",
        scopeId: measureId,
        triggeredBy: TREND_HISTORY_TRIGGER,
        status: "COMPLETED",
        startedAt,
        completedAt,
        requestedScope: { measureId, evaluationDate: dayOnly(startedAt), seedTrendHistory: true },
        measurementPeriodStart: periodStart,
        measurementPeriodEnd: periodEnd,
      });
      runsCreated++;

      const rate = historicalComplianceRate(rateKey, w, weeks);
      const assignments = seededDistributionAtRate(employees, rateKey, rate);
      const evaluationPeriod = dayOnly(startedAt);
      const inputs: RecordOutcomeInput[] = assignments.map((a) => {
        const status = outcomeByPair.get(`${measureId}|${a.target}`) ?? "MISSING_DATA";
        return {
          runId: run.id,
          subjectId: a.employee.externalId,
          measureId,
          evaluationPeriod,
          status,
          // Backdate evaluated_at to the run's completion (NOT now), or these synthetic historical
          // rows would out-sort the real latest outcome in `evaluated_at DESC` reads
          // (listOutcomesForEmployee / check_compliance) and mask current compliance (Codex P1).
          evaluatedAt: completedAt,
          evidence: { seedTrendHistory: true, target: a.target, rate },
        };
      });
      await deps.outcomeStore.recordOutcomes(inputs);
      outcomesCreated += inputs.length;
    }
  }

  return { skipped: false, weeks, measures: RUNNABLE_MEASURE_IDS.length, runsCreated, outcomesCreated };
}
