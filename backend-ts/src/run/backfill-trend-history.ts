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
 *   - Idempotent + resumable at WEEK level: seeding is tracked per (measure, day), so an interrupted
 *     run — or a later run with a larger `--weeks` — seeds only the missing weeks without duplicating
 *     existing ones; it's a full no-op only when every measure already has all `weeks` days.
 *   - Efficiency: `deriveExamConfig(binding, target)` + `buildSyntheticBundle` depend only on
 *     (measure, target), NOT on employee identity, so the engine outcome for a given (measure,
 *     target) is identical across employees. We precompute the (measure, target) → outcome map with
 *     11 measures × 5 targets = 55 engine evaluations, then assign all ~13.2k historical outcomes
 *     from the seeded distribution — not one engine call per employee.
 *
 * Invariants preserved: outcomes still come from the CQL engine (the (measure,target)→outcome map);
 * the synthetic write is audited (a required auditStore writes a `TREND_HISTORY_SEEDED` audit_event
 * per seeded measure); NO schema change (only the optional backdating params over existing columns);
 * the worklist/cases are untouched (this NEVER calls a case-store upsert); the programs OVERVIEW is unaffected — each
 * measure's newest synthetic week is anchored strictly BEFORE that measure's latest real run, and
 * the overview selects max(runStartedAt) per measure, so a seeded point can never become "current".
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, RecordOutcomeInput } from "../stores/outcome-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
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
/** Audit event_type appended (once per seeded measure) so the synthetic write is on the ledger. */
export const TREND_HISTORY_SEEDED_EVENT = "TREND_HISTORY_SEEDED";

const DEFAULT_WEEKS = 12;
const DAY_MS = 86_400_000;
const RUNNABLE_MEASURE_IDS = Object.keys(MEASURES);
const TARGETS: TargetOutcome[] = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"];

export interface BackfillTrendHistoryDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  engine: EvaluateMeasureBinding;
  /**
   * Audit ledger — REQUIRED. The backfill appends a `TREND_HISTORY_SEEDED` audit_event per seeded
   * measure (the CLI wires `stores.events`). Mandatory (not optional) so no caller can mutate
   * persisted state without an audit row — the "every state change writes audit_event" hard rule
   * (CLAUDE.md). The CQL engine is still the outcome source; this only records the mutation.
   */
  auditStore: CaseEventStore;
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
 * The set of seeded DAYS (YYYY-MM-DD) already present for a measure — the day of each
 * `seedTrendHistory` outcome's evaluated_at (= that run's completion day). Drives WEEK-LEVEL
 * idempotency: a rerun (or a later run with a larger `--weeks`) seeds only the weeks whose day is
 * missing, so it resumes a partially-seeded measure WITHOUT duplicating weeks (Codex P2 — a single
 * marker row must NOT mark a measure "complete"). Resume assumes the same `--as-of` + stable
 * real-run state (a different anchor shifts the target days).
 */
async function seededDaysForMeasure(outcomeStore: OutcomeStore, measureId: string): Promise<Set<string>> {
  const rows = await outcomeStore.listOutcomesForMeasure(measureId);
  const days = new Set<string>();
  for (const r of rows) {
    if ((r.evidence as { seedTrendHistory?: boolean } | null)?.seedTrendHistory === true) days.add(dayOnly(r.evaluatedAt));
  }
  return days;
}

/**
 * The latest REAL population-run `started_at` (ms) for a measure, or null if none. The newest
 * synthetic week is anchored strictly BEFORE this so seeded history never becomes the measure's
 * "current" run — `programOverview` selects `max(runStartedAt)` per measure, so a synthetic point
 * newer than the last real run would hijack the overview KPI (Codex P2). Prior seeded runs are
 * EXCLUDED BY IDENTITY (their `triggered_by` marker, not their calendar day) so a real run that
 * happens to share a day with a seeded week is still counted, and the anchor stays stable across
 * reruns (excluding by day could drop a same-day real run and let a resume anchor at asOf).
 */
async function latestRealRunMs(outcomeStore: OutcomeStore, measureId: string): Promise<number | null> {
  const rows = await outcomeStore.listOutcomesWithRun({ measureId });
  let max: number | null = null;
  for (const r of rows) {
    if (!isPopulationRun(r.runScopeType)) continue; // exclude CASE/EMPLOYEE reruns (overview parity)
    if (r.runTriggeredBy === TREND_HISTORY_TRIGGER) continue; // exclude this feature's own seeded runs (by marker)
    const t = Date.parse(r.runStartedAt);
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * Backfill weekly backdated COMPLETED runs (oldest→newest) for every runnable measure so the trend
 * charts show a varied line. WEEK-LEVEL idempotent + resumable: only weeks whose day is not already
 * seeded are created, so an interrupted run (or a later run with a larger `--weeks`) fills the gaps
 * without duplicating weeks; `skipped:true` only when every measure already has all `weeks` days.
 * Each measure's newest week is anchored strictly before its latest real run, so the programs
 * OVERVIEW is never hijacked. Appends a `TREND_HISTORY_SEEDED` audit event per seeded measure (the
 * auditStore is required). Never touches the case store.
 */
export async function backfillTrendHistory(
  deps: BackfillTrendHistoryDeps,
  opts: BackfillTrendHistoryOptions = {},
): Promise<BackfillTrendHistorySummary> {
  const employees = deps.employees ?? EMPLOYEES;
  const weeks = Math.max(1, Math.trunc(opts.weeks ?? DEFAULT_WEEKS));
  const asOf = (opts.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const asOfMs = Date.parse(`${asOf}T00:00:00.000Z`);

  // Per-measure seeded days (week-level idempotency / resume): a measure already holding all `weeks`
  // target days needs no work; otherwise we seed only its missing weeks.
  const seededDays = new Map<string, Set<string>>();
  let anyWork = false;
  for (const measureId of RUNNABLE_MEASURE_IDS) {
    const days = await seededDaysForMeasure(deps.outcomeStore, measureId);
    seededDays.set(measureId, days);
    if (days.size < weeks) anyWork = true;
  }
  const sample = employees[0];
  if (!anyWork || !sample) {
    return { skipped: !anyWork, weeks, measures: RUNNABLE_MEASURE_IDS.length, runsCreated: 0, outcomesCreated: 0 };
  }
  const outcomeByPair = await precomputeOutcomes(deps.engine, sample, asOf);

  let runsCreated = 0;
  let outcomesCreated = 0;

  for (const measureId of RUNNABLE_MEASURE_IDS) {
    const existingDays = seededDays.get(measureId)!;
    if (existingDays.size >= weeks) continue; // measure already fully seeded
    const rateKey = MEASURE_BINDINGS[measureId]!.rateKey;
    // Anchor the newest synthetic week strictly BEFORE this measure's latest real run (≥ 1 day),
    // capped at asOf, so seeded history never out-ranks the real current run on the overview. If the
    // measure has no real run yet, anchor at asOf (the seed legitimately populates an empty card).
    const latestReal = await latestRealRunMs(deps.outcomeStore, measureId);
    const anchorMs = latestReal != null ? Math.min(asOfMs, latestReal - DAY_MS) : asOfMs;
    let measureRuns = 0;
    let measureOutcomes = 0;
    let lastRunId: string | null = null;
    // Oldest → newest so started_at strictly increases (week 0 = oldest, weeks-1 = newest = anchor).
    for (let w = 0; w < weeks; w++) {
      const weeksBack = weeks - 1 - w; // weeks-1 back for the oldest, 0 for the newest (= anchor)
      const startedMs = anchorMs - weeksBack * 7 * DAY_MS;
      const startedAt = new Date(startedMs).toISOString();
      const day = dayOnly(startedAt);
      if (existingDays.has(day)) continue; // week already seeded — resume without duplicating
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
        requestedScope: { measureId, evaluationDate: day, seedTrendHistory: true },
        measurementPeriodStart: periodStart,
        measurementPeriodEnd: periodEnd,
      });
      lastRunId = run.id;
      measureRuns++;

      const rate = historicalComplianceRate(rateKey, w, weeks);
      const assignments = seededDistributionAtRate(employees, rateKey, rate);
      const inputs: RecordOutcomeInput[] = assignments.map((a) => {
        const status = outcomeByPair.get(`${measureId}|${a.target}`) ?? "MISSING_DATA";
        return {
          runId: run.id,
          subjectId: a.employee.externalId,
          measureId,
          evaluationPeriod: day,
          status,
          // Backdate evaluated_at to the run's completion (NOT now), or these synthetic historical
          // rows would out-sort the real latest outcome in `evaluated_at DESC` reads
          // (listOutcomesForEmployee / check_compliance) and mask current compliance (Codex P1).
          evaluatedAt: completedAt,
          evidence: { seedTrendHistory: true, target: a.target, rate },
        };
      });
      await deps.outcomeStore.recordOutcomes(inputs);
      measureOutcomes += inputs.length;
    }

    runsCreated += measureRuns;
    outcomesCreated += measureOutcomes;
    // Audit the synthetic write — "every state change writes audit_event" (CLAUDE.md). One ledger
    // row per seeded measure, tagged with the seed trigger as actor so it's filterable/reversible.
    if (measureRuns > 0) {
      await deps.auditStore.appendAudit({
        eventType: TREND_HISTORY_SEEDED_EVENT,
        entityType: "run",
        entityId: lastRunId,
        actor: TREND_HISTORY_TRIGGER,
        refRunId: lastRunId,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: { measureId, weeks, asOf, runsCreated: measureRuns, outcomesCreated: measureOutcomes },
      });
    }
  }

  return { skipped: false, weeks, measures: RUNNABLE_MEASURE_IDS.length, runsCreated, outcomesCreated };
}
