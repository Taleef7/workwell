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
import { engineForEnv } from "../engine/cql/engine-factory.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { ensureSegmentSeed } from "../segment/segment-seed.ts";
import { planManualRun, finishOrFail } from "../run/run-pipeline.ts";
import { emitAlert, resolveAlertChannels, type AlertChannel } from "../run/alert-channel.ts";

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
/** Wall-clock ms when the scheduler was last enabled — used to compute the first-fire gate. */
let _enabledAtMs: number | null = null;

/** Read WORKWELL_SCHEDULER_ENABLED from env once at startup and set the flag. */
export function initSchedulerFromEnv(env: { WORKWELL_SCHEDULER_ENABLED?: string }): void {
  const val = (env.WORKWELL_SCHEDULER_ENABLED ?? "").trim().toLowerCase();
  setSchedulerEnabled(val === "true" || val === "1");
}

/**
 * Programmatically enable or disable the scheduler (e.g. from the admin toggle route).
 * The optional `enabledAtMs` override is for tests — in production it defaults to Date.now().
 */
export function setSchedulerEnabled(enabled: boolean, enabledAtMs?: number): void {
  schedulerEnabled = enabled;
  _enabledAtMs = enabled ? (enabledAtMs ?? Date.now()) : null;
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
  const schedulerRun = await stores.runs.getLastRunByTriggeredBy("scheduler");
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
  /** Alert fan-out for FAILED runs + tick errors (#264). Default = console-only. */
  alertChannels?: readonly AlertChannel[];
}

/**
 * One scheduler tick. Returns true if a run was triggered, false if skipped.
 *
 * Invariant: the SCHEDULER_RUN_TRIGGERED audit event is written BEFORE the run is created.
 * finishOrFail never throws — safe to hand to ctx.waitUntil.
 *
 * @param nowMs - Current time in ms (injectable for tests; defaults to Date.now()).
 */
export async function runTick(deps: SchedulerTickDeps, nowMs = Date.now()): Promise<boolean> {
  if (!schedulerEnabled) return false;

  // Debounce (Fable M9 — known limitation): this read-then-write debounce serializes ticks WITHIN a
  // process (the single in-process setInterval), which is the live deployment (one `twh-api-ts`
  // container; the self-heal reconciler shares a concurrency group with the deploy so two containers
  // never run concurrently). It is NOT a cross-process claim: two schedulers ticking in the same window
  // could both pass this check and double-fire. A fully race-free claim needs an ATOMIC DB mutex — a
  // unique marker per cycle window (e.g. a `scheduler_claims(cycle_window UNIQUE)` row or a partial
  // unique index on runs). That is owner-gated schema (CLAUDE.md: migrations are Taleef's), so it is
  // documented here rather than added by an agent. Given the single-container topology the practical
  // double-fire risk is low; the worst case is one extra idempotent ALL_PROGRAMS recompute.
  // P2-2 fix: targeted single-row query avoids the listRuns page cap.
  const lastSchedulerRun = await deps.stores.runs.getLastRunByTriggeredBy("scheduler");
  if (lastSchedulerRun) {
    // Skip if the last scheduler run is less than (interval - 0.5 h) old.
    const elapsed = nowMs - new Date(lastSchedulerRun.startedAt).getTime();
    const minGapMs = (SCHEDULER_RUN_INTERVAL_HOURS - 0.5) * 3_600_000;
    if (elapsed < minGapMs) return false;
  } else {
    // P2-1 fix: no prior run — honor the next-fire time computed at enable time.
    // Wait until today's 06:00 UTC has passed (or tomorrow's if enabled past 06:00).
    if (_enabledAtMs !== null) {
      const ref = new Date(_enabledAtMs);
      const refSix = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 6, 0, 0, 0));
      const firstFireAt = _enabledAtMs < refSix.getTime() ? refSix.getTime() : refSix.getTime() + 24 * 3_600_000;
      if (nowMs < firstFireAt) return false;
    }
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
  const alertChannels = deps.alertChannels ?? resolveAlertChannels({});
  const runDeps = {
    runStore: deps.stores.runs,
    outcomeStore: deps.stores.outcomes,
    caseStore: deps.stores.cases,
    engine: deps.engine,
    segments: deps.segments,
    employees: deps.employees,
    // The scheduled ALL_PROGRAMS run materializes a quality-over-time snapshot for the period (#E16).
    qualitySnapshots: deps.stores.qualitySnapshots,
    events: deps.stores.events,
    actor: "scheduler", // system-initiated: audit rows attribute to the scheduler, not a user (Codex P1)
    alertChannels, // #264 — FAILED/PARTIAL_FAILURE from the nightly run is not silent
  };

  const planned = await planManualRun(runDeps, {
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "scheduler",
  });

  await finishOrFail(runDeps, planned);
  return true;
}

// ---------------------------------------------------------------------------
// Production wrapper
// ---------------------------------------------------------------------------

/**
 * Production wrapper: resolve stores + segments + the env-selected engine, then call runTick.
 * The engine carries the VSAC ValueSetResolver when WORKWELL_VSAC_API_KEY is set (key-gated;
 * inline path otherwise) — so the nightly ALL_PROGRAMS run honors the same resolver as the routes.
 * Errors are logged but never rethrown — safe to hand to ctx.waitUntil.
 */
export async function schedulerTick(env: StoresEnv & { WORKWELL_ALERT_WEBHOOK_URL?: string }): Promise<void> {
  const alertChannels = resolveAlertChannels(env);
  try {
    await ensureSegmentSeed(env);
    const stores = await getStores(env);
    const engine = await engineForEnv(env);
    const allSegments = await stores.segments.listSegments();
    const enabledSegments = allSegments.filter((s) => s.enabled);
    await runTick({ stores, engine, segments: enabledSegments, alertChannels });
  } catch (err) {
    console.error("[scheduler] tick error:", err);
    // Observability (#264): a scheduler tick throw (store/plan failure before finishOrFail) must
    // not be silent. Best-effort — never rethrow; the tick is safe for ctx.waitUntil.
    await emitAlert(alertChannels, {
      kind: "SCHEDULER_TICK_ERROR",
      at: new Date().toISOString(),
      status: "ERROR",
      message: `Scheduler tick error: ${String((err as Error)?.message ?? err)}`,
    });
  }
}
