/**
 * Scheduled recompute (E13 PR-3).
 *
 * An in-process scheduler that fires audited ALL_PROGRAMS runs on a 24-hour interval.
 * The scheduler is opt-in: disabled by default, toggled via WORKWELL_SCHEDULER_ENABLED=true
 * or programmatically via setSchedulerEnabled(). State is in-memory and resets on restart —
 * this is intentional for the demo stack; a persistent scheduler setting is a future drop-in.
 *
 * Invariant: the SCHEDULER_RUN_TRIGGERED audit event is written BEFORE the run is created
 * (CLAUDE.md hard rule: every state change writes audit_event — no exceptions).
 *
 * Designed to be called by the host's periodic tick (e.g. ctx.waitUntil on a cron trigger
 * or the admin/scheduler route). finishOrFail never throws, so schedulerTick is safe to
 * hand to ctx.waitUntil.
 */
import type { Stores, StoresEnv } from "../stores/factory.ts";
import { getStores } from "../stores/factory.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { ensureSegmentSeed } from "../segment/segment-seed.ts";
import { planManualRun, finishOrFail } from "../run/run-pipeline.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Display-only cron expression — the actual interval is SCHEDULER_RUN_INTERVAL_HOURS. */
export const SCHEDULER_CRON = "0 0 6 * * *";

/** How many hours must elapse between scheduler-triggered ALL_PROGRAMS runs. */
const SCHEDULER_RUN_INTERVAL_HOURS = 24;

// ---------------------------------------------------------------------------
// In-memory toggle (demo; resets on restart)
// ---------------------------------------------------------------------------

let schedulerEnabled = false;

/** Read WORKWELL_SCHEDULER_ENABLED from env once at startup and set the flag. */
export function initSchedulerFromEnv(env: { WORKWELL_SCHEDULER_ENABLED?: string }): void {
  const val = (env.WORKWELL_SCHEDULER_ENABLED ?? "").trim().toLowerCase();
  schedulerEnabled = val === "true" || val === "1";
}

/** Programmatically enable or disable the scheduler (e.g. from the admin toggle route). */
export function setSchedulerEnabled(enabled: boolean): void {
  schedulerEnabled = enabled;
}

/** Returns the current in-memory enabled state. */
export function isSchedulerEnabled(): boolean {
  return schedulerEnabled;
}

// ---------------------------------------------------------------------------
// Status shape
// ---------------------------------------------------------------------------

export interface SchedulerStatus {
  enabled: boolean;
  /** Display cron expression (human-readable; actual interval is SCHEDULER_RUN_INTERVAL_HOURS). */
  cron: string;
  /** ISO-8601 estimated next fire time, or null when disabled or unknown. */
  nextFireAt: string | null;
  /** ISO-8601 timestamp of the last scheduler-triggered run's started_at, or null if none. */
  lastRunAt: string | null;
  /** Status string of the last scheduler-triggered run ("unknown" if none). */
  lastRunStatus: string;
}

// ---------------------------------------------------------------------------
// Private helper: compute next fire time
// ---------------------------------------------------------------------------

function computeNextFireAt(lastAt: string | null): string | null {
  if (!schedulerEnabled) return null;
  if (!lastAt) {
    // No prior run: schedule for today's 06:00 UTC, or tomorrow's if already past.
    const now = new Date();
    const todaySix = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0, 0));
    if (now.getTime() < todaySix.getTime()) return todaySix.toISOString();
    // Past 06:00 today — next is tomorrow 06:00.
    todaySix.setUTCDate(todaySix.getUTCDate() + 1);
    return todaySix.toISOString();
  }
  return new Date(new Date(lastAt).getTime() + SCHEDULER_RUN_INTERVAL_HOURS * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------
// Status query (injectable: works with any Stores bundle)
// ---------------------------------------------------------------------------

/**
 * Query the runs table for the most recent scheduler-triggered run and build a SchedulerStatus.
 * Injectable for tests — takes a resolved Stores bundle directly.
 */
export async function getSchedulerStatusFromStores(stores: Stores): Promise<SchedulerStatus> {
  const runs = await stores.runs.listRuns(50);
  const schedulerRun = runs.find((r) => r.triggeredBy === "scheduler");
  const lastRunAt = schedulerRun?.startedAt ?? null;
  const lastRunStatus = schedulerRun?.status ?? "unknown";
  return {
    enabled: schedulerEnabled,
    cron: SCHEDULER_CRON,
    nextFireAt: computeNextFireAt(lastRunAt),
    lastRunAt,
    lastRunStatus,
  };
}

/**
 * Convenience wrapper: resolves stores from env, then delegates to getSchedulerStatusFromStores.
 * Used by the route handler.
 */
export async function getSchedulerStatus(env: StoresEnv): Promise<SchedulerStatus> {
  const stores = await getStores(env);
  return getSchedulerStatusFromStores(stores);
}

// ---------------------------------------------------------------------------
// runTick — the core scheduler logic, injectable for tests
// ---------------------------------------------------------------------------

export interface SchedulerTickDeps {
  stores: Stores;
  engine: EvaluateMeasureBinding;
  segments: HydratedSegment[];
  employees?: readonly EmployeeProfile[];
}

/**
 * One scheduler tick. Returns true if a run was triggered, false if skipped.
 *
 * Invariant: the SCHEDULER_RUN_TRIGGERED audit event is written BEFORE the run is created.
 * finishOrFail never throws — safe to hand to ctx.waitUntil.
 */
export async function runTick(deps: SchedulerTickDeps): Promise<boolean> {
  if (!schedulerEnabled) return false;

  // Debounce: skip if a scheduler run already exists and is less than (interval - 0.5 h) old.
  const runs = await deps.stores.runs.listRuns(50);
  const lastSchedulerRun = runs.find((r) => r.triggeredBy === "scheduler");
  if (lastSchedulerRun) {
    const elapsed = Date.now() - new Date(lastSchedulerRun.startedAt).getTime();
    const minGapMs = (SCHEDULER_RUN_INTERVAL_HOURS - 0.5) * 3_600_000;
    if (elapsed < minGapMs) return false;
  }

  // Write the audit event BEFORE creating the run (hard rule: every state change writes audit_event).
  const now = new Date();
  await deps.stores.events.appendAudit({
    eventType: "SCHEDULER_RUN_TRIGGERED",
    entityType: "scheduler",
    entityId: null,
    actor: "scheduler",
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: { cron: SCHEDULER_CRON, triggeredAt: now.toISOString() },
  });

  // Build run deps from the injected stores + engine + segments.
  const runDeps = {
    runStore: deps.stores.runs,
    outcomeStore: deps.stores.outcomes,
    caseStore: deps.stores.cases,
    engine: deps.engine,
    segments: deps.segments,
    employees: deps.employees,
  };

  const planned = await planManualRun(runDeps, {
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "scheduler",
  });

  await finishOrFail(runDeps, planned);
  return true;
}

// ---------------------------------------------------------------------------
// Shared process-level engine instance (production use)
// ---------------------------------------------------------------------------

const _engine = new CqlExecutionEngine();

/**
 * Production wrapper: resolve stores + segments, then call runTick.
 * Errors are logged but never rethrown — safe to hand to ctx.waitUntil.
 */
export async function schedulerTick(env: StoresEnv): Promise<void> {
  try {
    await ensureSegmentSeed(env);
    const stores = await getStores(env);
    const allSegments = await stores.segments.listSegments();
    const enabledSegments = allSegments.filter((s) => s.enabled);
    await runTick({ stores, engine: _engine, segments: enabledSegments });
  } catch (err) {
    console.error("[scheduler] tick error:", err);
  }
}
