/**
 * Scheduled recompute (E13 PR-3).
 *
 * An in-process scheduler that fires audited ALL_PROGRAMS runs on a 24-hour interval.
 * The scheduler is opt-in: disabled by default, toggled via WORKWELL_SCHEDULER_ENABLED=true
 * or programmatically via setSchedulerEnabled(). The opt-in flag is in-memory and resets on restart;
 * run cadence is derived from persisted scheduler runs.
 *
 * Invariant: the SCHEDULER_RUN_TRIGGERED audit event is written BEFORE the run is created
 * (CLAUDE.md hard rule: every state change writes audit_event — no exceptions).
 *
 * Designed to be called by the host's periodic tick (e.g. ctx.waitUntil on a cron trigger
 * or the admin/scheduler route). finishOrFail never throws, so schedulerTick is safe to
 * hand to ctx.waitUntil.
 */
import type { Stores, StoresEnv } from "../stores/factory.ts";
import { compactOutcomes, retentionDaysFromEnv } from "../run/outcome-compaction.ts";
import { getStores } from "../stores/factory.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import type { EvaluateMeasureBinding } from "@work-well/measure-engine";
import { routedEngineForEnv } from "../wiring/executor-router.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { ensureSegmentSeed } from "../segment/segment-seed.ts";
import {
  planManualRun,
  finishOrFail,
  type RunPipelineDeps,
  type WebChartRunEnv,
} from "../run/run-pipeline.ts";
import { isIncrementalEnabled } from "../run/incremental/incremental-eval.ts";
import { isVsacConfigured } from "@work-well/measure-engine";
import type { WebChartClient } from "../engine/ingress/webchart/webchart-client.ts";
import { emitAlert, resolveAlertChannels, type AlertChannel } from "../run/alert-channel.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Display-only cron expression, DERIVED from the anchor hour so the admin surface cannot show one time
 * beside a `nextFireAt` at another. It was the literal "0 0 6 * * *" while the anchor defaulted to 12.
 */
export const SCHEDULER_CRON = (): string => `0 0 ${SCHEDULER_ANCHOR_HOUR_UTC()} * * *`;

/** How many hours must elapse between scheduler-triggered ALL_PROGRAMS runs. */
const SCHEDULER_RUN_INTERVAL_HOURS = 24;
/** The debounce floor: half an hour under a day, as the tick has always used. */
const DEFAULT_MIN_GAP_MS = (SCHEDULER_RUN_INTERVAL_HOURS - 0.5) * 3_600_000;

// ---------------------------------------------------------------------------
// In-memory toggle (demo; resets on restart)
// ---------------------------------------------------------------------------

let schedulerEnabled = false;

/**
 * In-memory "next run is due at" cache — a COMPUTE-COST guardrail, not a correctness mechanism.
 *
 * `null` means "unknown, consult the DB". It is deliberately NOT persisted: the durable cadence
 * still lives in the persisted scheduler runs (#268), so a restart resets this to null and the
 * first tick re-derives the true next-due time from `getLastRunByTriggeredBy`. This cache only
 * suppresses the ~287 redundant DB round trips per day between two daily runs.
 *
 * Why this matters: the tick fires every few minutes but the decision it makes changes once every
 * 24 h. Waking a serverless Postgres (Neon suspends after ~5 min idle) on every tick pins the
 * compute on 24/7 — roughly 182 CU-hours/month of pure idle polling, which exhausted the plan's
 * monthly compute quota and took the live stack down 2026-07-18 → 07-22 (all DB-backed routes
 * 500'd with HTTP 402 from the pooler). Keeping the DB untouched between runs lets it sleep.
 */
let nextDueAtMs: number | null = null;

/**
 * Single-flight guard: true while a tick is between its cadence read and its run creation.
 *
 * Separate from `nextDueAtMs` because the two solve different problems (Codex P2, #323 review).
 * The due cache is a *cost* optimisation over the durable cadence and is only booked once a run is
 * persisted; it therefore cannot bound CONCURRENCY. If a tick stalls inside appendAudit or
 * planManualRun for longer than the timer period — the Postgres pool sets no query timeout, so a
 * hung database does exactly that — the next timer callback would find the gate null and proceed.
 * Both ticks may already have read "no prior scheduler run", so when the database recovers both
 * append a trigger event and create an ALL_PROGRAMS run.
 *
 * Note this bounds overlap only WITHIN a process, which matches the single-container topology
 * documented on the debounce below; a cross-process claim still needs the owner-gated DB mutex
 * described there.
 */
let tickInFlight = false;

/** Read WORKWELL_SCHEDULER_ENABLED from env once at startup and set the flag. */
export function initSchedulerFromEnv(env: { WORKWELL_SCHEDULER_ENABLED?: string }): void {
  const val = (env.WORKWELL_SCHEDULER_ENABLED ?? "").trim().toLowerCase();
  setSchedulerEnabled(val === "true" || val === "1");
}

/**
 * Programmatically enable or disable the scheduler (e.g. from the admin toggle route).
 */
export function setSchedulerEnabled(enabled: boolean): void {
  schedulerEnabled = enabled;
  // Invalidate the due cache: an operator toggle (or a restart re-running initSchedulerFromEnv)
  // must re-consult the persisted cadence rather than honour a stale in-memory gate.
  nextDueAtMs = null;
}

/**
 * DB-free pre-check: may this tick skip ALL store work?
 *
 * Called at the top of `schedulerTick` so that a tick which cannot possibly fire costs zero
 * database round trips — and therefore never wakes a suspended serverless compute. Returns
 * `false` whenever the answer is not certain (cold cache), so the durable cadence read is
 * always the fallback and correctness never depends on this cache.
 */
export function shouldSkipTickWithoutDb(nowMs = Date.now()): boolean {
  if (!schedulerEnabled) return true;
  return nextDueAtMs !== null && nowMs < nextDueAtMs;
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
  /** Display cron expression, derived from the anchor hour — which IS the schedule (see `dueAtMs`). */
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

/**
 * The wall-clock hour (UTC) the nightly run is anchored to. 12 UTC is 02:00 in Hawaii, which is what
 * the pilot wants: the overnight recompute finishes before the clinic opens, every day, at the same
 * time. Without an anchor the cadence is "24 h after whenever the last one happened", so a single
 * late run drags every subsequent run later and the nightly job walks around the clock.
 */
const SCHEDULER_ANCHOR_HOUR_UTC = (): number => {
  const raw = process.env.WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC;
  if (raw === undefined || raw === "") return 12;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    console.warn(`[workwell] WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC="${raw}" is not an hour 0-23; using 12.`);
    return 12;
  }
  return parsed;
};

export interface NextFireInput {
  /** `startedAt` of the last scheduler run, in ms; null when the deployment has never run one. */
  lastRunAtMs: number | null;
  nowMs: number;
  anchorHourUtc?: number;
  /** The debounce, as a FLOOR under the anchor rather than the cadence itself. */
  minGapMs?: number;
}

/**
 * When the nightly run next fires.
 *
 * **One function, used by BOTH the status display and the tick** — that is the point of it. These
 * were two independent calculations: this one produced the `nextFireAt` a human reads, while the
 * decision to actually fire was an inline `elapsed < minGapMs` check inside the tick. Changing only
 * this one would have moved the displayed time and nothing else, under a commit message claiming the
 * nightly run had moved.
 *
 * The anchor is the schedule; the min-gap is a floor beneath it. An anchor that falls inside the
 * debounce window is pushed to the next day rather than firing early — otherwise a run at 11:00
 * followed by the 12:00 anchor would fire twice in an hour.
 *
 * `lastRunAtMs === null` keeps today's meaning: fire on the next tick. A freshly deployed instance
 * must not sit idle until the anchor comes round.
 */
export function computeNextFireAt(input: NextFireInput): string {
  if (input.lastRunAtMs === null) return new Date(input.nowMs).toISOString();
  const due = dueAtMs(input);
  // Already due (an overdue backfill) reports NOW, matching the never-run case: the answer to "when
  // does it next fire" is "on the next tick", not the anchor after this one.
  return new Date(Math.max(due, input.nowMs) === due ? due : input.nowMs).toISOString();
}

/**
 * The instant this deployment is next SCHEDULED to run, derived from the last run alone.
 *
 * **The rule is: at most one scheduled run per UTC day, at the anchor hour.** If the last scheduler run
 * happened before that day's anchor, the day still owes its run; otherwise the next is the following
 * day's anchor.
 *
 * **Why this is not "last run + a debounce".** The first version floored on `lastRun + 23.5 h` and took
 * the next anchor at or after that floor — which SKIPS A WHOLE NIGHT for any run starting more than
 * thirty minutes past the anchor. Measured: a run at 12:30 UTC gave a next fire 47.5 hours later, and
 * one at 15:00 gave 45 hours, with `shouldFireAt` false straight through the intervening night. The
 * commonest trigger is the most ordinary one — the first run after a deploy, or after the scheduler is
 * enabled, fires at whatever the wall clock is, so any working-hours deploy silently cost the pilot the
 * next night's recompute. A 23.5-hour floor is a CADENCE calibrated to a daily interval; under an
 * anchor the schedule IS the anchor, and the only thing worth preventing is firing twice for the same
 * day, which "the last run was before this day's anchor" prevents with no duration to mis-calibrate.
 *
 * Deliberately independent of `now`: the tick asks "is a run due?", and a function that floors on the
 * current time can never answer yes — the moment now passes the anchor it starts reporting tomorrow's.
 * Flooring on `now` is right for a display and wrong for a decision, and the two callers need both.
 */
function dueAtMs(input: NextFireInput): number {
  const anchorHour = input.anchorHourUtc ?? SCHEDULER_ANCHOR_HOUR_UTC();
  const lastRunAtMs = input.lastRunAtMs ?? 0;
  const last = new Date(lastRunAtMs);
  const anchorOn = (addDays: number) =>
    Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() + addDays, anchorHour, 0, 0, 0);
  const owedToday = anchorOn(0);
  return lastRunAtMs < owedToday ? owedToday : anchorOn(1);
}

export function shouldFireAt(input: NextFireInput): boolean {
  if (input.lastRunAtMs === null) return true;
  return input.nowMs >= dueAtMs(input);
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
    cron: SCHEDULER_CRON(),
    nextFireAt: schedulerEnabled
      ? computeNextFireAt({ lastRunAtMs: lastRunAt ? Date.parse(lastRunAt) : null, nowMs: Date.now() })
      : null,
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
  /** Runtime WebChart configuration; selection remains inside planManualRun via isWebChartConfigured. */
  webChartEnv?: WebChartRunEnv;
  /** Existing verified client seam, threaded only for tests/offline scheduler callers. */
  webChartClient?: WebChartClient;
  /** Alert fan-out for FAILED runs + tick errors (#264). Default = console-only. */
  alertChannels?: readonly AlertChannel[];
  /** #263 — reuse unchanged subjects' prior outcomes on the nightly run. Inert unless the flag is set. */
  incremental?: boolean;
  /** #263 — whether the value-set resolver is active (feeds logic_version); default false. */
  expansionActive?: boolean;
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

  // Single-flight (Codex P2, #323): a stalled tick must not let the next timer callback in. The
  // guard spans the cadence read AND the writes, because the double-fire comes from two ticks both
  // observing "no prior run" before either has created one. Released in `finally` so a thrown tick
  // never wedges the scheduler permanently.
  if (tickInFlight) return false;
  tickInFlight = true;
  try {
    return await runTickLocked(deps, nowMs);
  } finally {
    tickInFlight = false;
  }
}

/** The tick body proper. Only ever called with the single-flight guard held. */
async function runTickLocked(deps: SchedulerTickDeps, nowMs: number): Promise<boolean> {
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
  const minGapMs = DEFAULT_MIN_GAP_MS;
  if (lastSchedulerRun) {
    // The ANCHOR decides, through the same function the status display reads — not a bare elapsed-time
    // check. This was an inline `elapsed < minGapMs`, which is a cadence rather than a schedule: one
    // late run dragged every later run with it and the nightly job walked around the clock.
    const lastStartedMs = new Date(lastSchedulerRun.startedAt).getTime();
    if (!shouldFireAt({ lastRunAtMs: lastStartedMs, nowMs, minGapMs })) {
      // Remember when this becomes due so the intervening ticks need no DB round trip at all. The
      // cached due time is the ANCHOR too, so a tick between the debounce lapsing and the anchor
      // arriving still skips the query.
      nextDueAtMs = dueAtMs({ lastRunAtMs: lastStartedMs, nowMs, minGapMs });
      return false;
    }
  }

  // NOTE: the due cache is deliberately NOT booked here (Codex P1, #322 review). Everything below
  // this line can throw — appendAudit and planManualRun both write to the database, and a transient
  // failure there is exactly the condition this guardrail exists to survive. Booking the cooldown
  // before a run is durably persisted would make schedulerTick's catch swallow the error while every
  // later tick skipped the DB for 23.5 h, silently losing a day's recompute with no run to show for
  // it. The cache is an optimisation over the persisted cadence, so it may only be trusted once that
  // cadence actually exists — see below, after planManualRun.

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
    payload: { cron: SCHEDULER_CRON(), triggeredAt: now.toISOString() },
  });

  // Build run deps from the injected stores + engine + segments.
  const alertChannels = deps.alertChannels ?? resolveAlertChannels({});
  const runDeps: RunPipelineDeps = {
    runStore: deps.stores.runs,
    outcomeStore: deps.stores.outcomes,
    caseStore: deps.stores.cases,
    engine: deps.engine,
    segments: deps.segments,
    employees: deps.employees,
    webChartEnv: deps.webChartEnv,
    webChartClient: deps.webChartClient,
    // The scheduled ALL_PROGRAMS run materializes a quality-over-time snapshot for the period (#E16).
    qualitySnapshots: deps.stores.qualitySnapshots,
    events: deps.stores.events,
    actor: "scheduler", // system-initiated: audit rows attribute to the scheduler, not a user (Codex P1)
    alertChannels, // #264 — FAILED/PARTIAL_FAILURE from the nightly run is not silent
    evalState: deps.stores.evalState, // #263 incremental cache (inert unless deps.incremental)
    incremental: deps.incremental,
    expansionActive: deps.expansionActive, // #263 — folds value-set membership into logic_version
    valueSets: deps.stores.valueSets,
  };

  const planned = await planManualRun(runDeps, {
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "scheduler",
  });

  // The run row now exists with triggeredBy='scheduler', so the persisted cadence itself would
  // already debounce the next tick — booking the cache here just saves that DB round trip. Doing it
  // BEFORE the (long) finishOrFail also means an overlapping tick during a slow ALL_PROGRAMS run
  // cannot double-fire, without the cache ever running ahead of the durable state it summarises.
  // The ANCHOR, not `now + gap` — the same rule the tick and the display use, so a run that fired
  // late does not drag the next one late with it.
  nextDueAtMs = dueAtMs({ lastRunAtMs: nowMs, nowMs, minGapMs });

  await finishOrFail(runDeps, planned);

  /**
   * Retention (ADR-073), AFTER the run and therefore after its quality snapshot — `finishManualRun`
   * materializes the snapshot as part of finalizing, so compacting before this line would delete the
   * per-subject rows the aggregate is computed from and the durable history would be built from a
   * roster with holes in it. The ordering is pinned by `outcome-compaction.test.ts`.
   *
   * Inert unless `WORKWELL_OUTCOME_RETENTION_DAYS` is set, and best-effort: a compaction failure must
   * not fail a run that has already completed and been reported.
   */
  await compactOutcomes(deps.stores, { retentionDays: retentionDaysFromEnv(process.env as Record<string, unknown>), now: nowMs })
    .catch((err) => {
      console.warn(`[workwell] outcome compaction failed: ${String((err as Error)?.message ?? err)}`);
      return null;
    });

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
export async function schedulerTick(
  env: StoresEnv & WebChartRunEnv & { WORKWELL_ALERT_WEBHOOK_URL?: string; WORKWELL_INCREMENTAL_EVAL?: string; WORKWELL_VSAC_API_KEY?: string; WORKWELL_VSAC_BASE_URL?: string },
): Promise<void> {
  // COMPUTE-COST GUARDRAIL (#322) — must stay the first statement in this function.
  //
  // Everything below (ensureSegmentSeed, getStores, engineForEnv, listSegments, and runTick's own
  // getLastRunByTriggeredBy) issues database work. Running that on every tick meant ~1,300 queries
  // a day to answer a question whose answer changes once a day, which kept a serverless Postgres
  // permanently awake and burned the monthly compute quota. Note this ALSO used to run when the
  // scheduler was disabled, because the `schedulerEnabled` check lived inside runTick — i.e. an
  // opted-out deployment still paid the full polling cost.
  if (shouldSkipTickWithoutDb()) return;

  const alertChannels = resolveAlertChannels(env);
  try {
    await ensureSegmentSeed(env);
    const stores = await getStores(env);
    const engine = await routedEngineForEnv(env);
    const allSegments = await stores.segments.listSegments();
    const enabledSegments = allSegments.filter((s) => s.enabled);
    await runTick({ stores, engine, segments: enabledSegments, alertChannels, webChartEnv: env, incremental: isIncrementalEnabled(env), expansionActive: isVsacConfigured(env) });
  } catch (err) {
    // Invalidate the due gate so the next tick re-consults the persisted cadence (Codex P1, #322
    // review). runTick already avoids booking the cooldown before its run is durable; this is the
    // belt-and-braces half — any failure anywhere in the tick path (store resolution, segment seed,
    // engine construction) returns the scheduler to "ask the database", never to a silent skip.
    nextDueAtMs = null;
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
