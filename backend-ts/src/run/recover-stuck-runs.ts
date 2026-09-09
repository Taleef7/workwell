/**
 * Boot recovery for runs orphaned by a container restart (#109 pre-retirement hardening).
 *
 * An ALL_PROGRAMS/SITE run is advanced by an in-process `ctx.waitUntil` task that does NOT survive a
 * restart (every push to `main` redeploys), so a run interrupted mid-flight is stuck RUNNING forever.
 * `RunStore.failStuckRuns` flips such runs to FAILED; this wraps it to ALSO write a `RUN_RECOVERED`
 * audit_event per recovered run. The store has no events binding, and "every state change writes an
 * audit_event — no exceptions" is a hard rule (AGENTS.md / CLAUDE.md), so the audit lives here, above
 * the store, where both the run store and the events store are in scope.
 *
 * If writing the audit event fails for a run, `restoreRecoveredRun` compensates by moving the run
 * back to its previous status (with completed_at cleared) so the next recovery sweep retries it,
 * an alert is emitted noting the failure and restore, and the run is excluded from the returned list.
 */
import type { RunStore, RecoveredRun } from "../stores/run-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { emitAlert, resolveAlertChannels, type AlertChannel } from "./alert-channel.ts";

export interface RecoverStuckRunsDeps {
  runs: RunStore;
  events: CaseEventStore;
  /** Optional alert fan-out (#264). Default = console-only when omitted. */
  alertChannels?: readonly AlertChannel[];
  /**
   * The process boot instant the cutoff is measured from. Production leaves it unset and the real one
   * is used. It exists so a test can drive the DEFAULT threshold path against a real store: passing
   * the threshold in as an argument instead leaves `orphanThresholdMs()` unexercised, which is how the
   * first version of that test passed with the wiring removed.
   */
  bootedAt?: number;
}

/**
 * Fail + audit any runs stuck RUNNING or unclaimed QUEUED beyond their respective thresholds (see
 * {@link RunStore.failStuckRuns}). Returns the successfully recovered and audited runs with their
 * previous status. Runs whose audit write fails are compensated by restoring them to their previous
 * status for retry on the next sweep and excluded from the return value.
 * Best-effort: callers run it fire-and-forget on boot. Emits one WORKWELL_ALERT per recovered run
 * (#264) so orphaned failures are not silent.
 */
/**
 * When THIS process started, from the runtime's own uptime rather than module-load time.
 *
 * Module load is close enough on both current entrypoints (each imports this eagerly), but a lazily
 * loaded route would stamp a module-load constant at FIRST REQUEST, putting the cutoff after boot and
 * sweeping this process's own live runs — the exact bug this file exists to fix, reintroduced
 * silently. `process.uptime()` closes that specific hole.
 *
 * It is NOT a general guarantee, and two earlier versions of this comment claimed one. `process.uptime()`
 * is monotonic while `Date.now()` is not, so the two disagree after anything that moves the wall clock,
 * and the negative-age guard below catches only SOME of that:
 *
 * - A host suspend. Linux `CLOCK_MONOTONIC` does not advance while suspended, so after a 2h suspend
 *   this lands 2h AFTER the real boot. The computed age stays POSITIVE, the guard does not fire, and
 *   the cutoff sits 2h past boot — sweeping live runs started in that window. Not defended against
 *   here; a container host that suspends is outside the deployment model, and detecting it needs a
 *   second clock source.
 * - A backward wall-clock step (NTP, hypervisor correction). The guard fires only while the clock is
 *   still behind this stamp. Once real time advances past it the age is positive again, so a run
 *   CREATED during the stepped-back interval keeps a `started_at` before the cutoff and can be swept
 *   while live. The exposure is bounded by the size of the step and by the sweep being once-per-process,
 *   but it is real and it is not covered.
 *
 * Both are honest residual risk rather than handled cases. What the guard does cover is the
 * catastrophic one: an age so wrong it would sweep EVERYTHING.
 */
export function bootInstant(nowMs: number, uptimeSeconds: number): number {
  return nowMs - Math.round(uptimeSeconds * 1000);
}

const BOOTED_AT = bootInstant(Date.now(), process.uptime());

/**
 * The threshold returned when the clock cannot be trusted: 100 years, so `now - threshold` lands in
 * the 1920s and matches no real `started_at`. It is a value rather than a null return so the QUEUED
 * half of `failStuckRuns` — which has its own independent 6-hour threshold — still runs.
 */
const SWEEP_NOTHING_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * How much earlier than boot to place the cutoff, absorbing the gap between computing this age and the
 * store applying it against its own `Date.now()`. Without it the effective cutoff lands a fraction of
 * a millisecond AFTER boot — the dangerous direction, because it can sweep a run this process started
 * in that instant. A second early can only miss an orphan that began in the final second of the
 * previous process, which the next restart picks up.
 */
const CUTOFF_MARGIN_MS = 1000;

/**
 * The age a RUNNING run must exceed to be treated as orphaned, for a sweep happening now.
 *
 * The whole rule is "started before this process booted". A run that began earlier cannot be advanced
 * by this process — its in-process task died with whatever process created it — so it is orphaned at
 * any age. A run that began later is live and must never be swept however long it runs.
 *
 * There is deliberately NO minimum. A floor can only push the cutoff EARLIER than boot, and earlier
 * than boot protects nothing: everything after boot is already protected by the age term. All a floor
 * does is suppress legitimate recoveries — with the old 30-minute one, a container that redeployed 20
 * minutes into a nightly booted, swept with a cutoff 30 minutes before boot, and left the orphan it
 * was there to catch. Both triggers are one-shot per process, so nothing caught it afterwards either.
 *
 * THE CUTOFF DOES NOT ADVANCE. `now` cancels: the effective cutoff is `bootedAt - CUTOFF_MARGIN_MS`
 * for the whole life of the process, however long it runs. So that margin is also this process's
 * entire tolerance for clock skew BETWEEN HOSTS: if a restart reschedules the container onto a host
 * whose clock is more than a second behind the previous one, an orphan the previous container started
 * has `started_at` after the cutoff and is not swept — for as long as this process lives. The old
 * flat threshold, whose cutoff did advance, tolerated that; this trades it away for never killing a
 * live run, which is the direction the 2026-09-09 incident argues for. The exposure is bounded by the
 * next restart (every push to `main` redeploys), not permanent.
 *
 * NOT covered, and stated rather than implied: a run orphaned by its own task dying inside a process
 * that keeps running. Its `started_at` is after boot, so this never sweeps it. A timestamp cannot
 * distinguish it from a healthy long run — but a PROGRESS signal can, and one already exists without
 * any schema change: `outcomes.evaluated_at` is written continuously by a running evaluation and
 * `outcomes` is indexed on `run_id`, so "RUNNING and no outcome row in N minutes" is available at the
 * cost of a per-run scan. (`run_logs` is NOT that signal — it is event-driven, and a healthy chunk
 * loop writes almost nothing.) That is the cheap follow-up, deliberately not in this change. The
 * previous flat threshold "handled" this case only by also killing healthy runs, which is what broke
 * the pilot's nightly on 2026-09-09.
 *
 * `started_at` is stamped at `createRun` (QUEUED), not at `markRunning`, so "started before boot" is
 * really "was CREATED before boot". Nothing today promotes a pre-existing QUEUED row to RUNNING in a
 * later process — the one path that would, `claimNextQueuedRun`, stamps `claimed_by`, which the sweep
 * excludes. That is luck rather than design: a claiming worker added on a path that does not stamp
 * `claimed_by` would make this sweep a live run whose row was queued before the restart.
 *
 * ASSUMES ONE CONTAINER at a time, the same assumption `admin/scheduler.ts` documents for its
 * debounce: with two replicas, the newer one's boot cutoff would sweep runs the older one is still
 * advancing. `claimed_by` is no protection there — the `ctx.waitUntil` path leaves it NULL.
 *
 * A NEGATIVE age means the wall clock moved backwards since `BOOTED_AT` was stamped, and in that
 * state the process cannot tell its own runs from a previous process's. It sweeps NOTHING. The
 * previous version clamped to `Math.max(0, …)`, which chose the opposite: a threshold of 0 makes the
 * store's cutoff `Date.now()`, and `started_at < now` matches EVERY unclaimed RUNNING row — the
 * 2026-09-09 incident reproduced exactly, by a clock step rather than by a stale constant. Missing a
 * sweep costs a stale RUNNING row until the next restart; taking the wrong one kills the nightly.
 */
export function orphanThresholdMs(now = Date.now(), bootedAt = BOOTED_AT): number {
  const age = now - bootedAt;
  if (!Number.isFinite(age) || age < 0) return SWEEP_NOTHING_MS;
  return age + CUTOFF_MARGIN_MS;
}

export async function recoverStuckRuns(
  deps: RecoverStuckRunsDeps,
  olderThanMs?: number,
  unclaimedQueuedOlderThanMs?: number,
): Promise<RecoveredRun[]> {
  const recovered = await deps.runs.failStuckRuns(
    olderThanMs ?? orphanThresholdMs(Date.now(), deps.bootedAt),
    unclaimedQueuedOlderThanMs,
  );
  const channels = deps.alertChannels ?? resolveAlertChannels({});
  const successful: RecoveredRun[] = [];

  for (const item of recovered) {
    const isQueued = item.previousStatus === "QUEUED";
    let auditFailed = false;
    try {
      await deps.events.appendAudit({
        eventType: "RUN_RECOVERED",
        entityType: "run",
        entityId: item.id,
        actor: "system",
        refRunId: item.id,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: {
          reason: isQueued
            ? "Unclaimed QUEUED run exceeded timeout threshold (no claiming worker active); failed by boot recovery."
            : "Orphaned by a container restart (the in-process run job did not survive); failed by boot recovery.",
        },
      });
    } catch (err) {
      auditFailed = true;
      console.error(`[workwell] RUN_RECOVERED audit failed for ${item.id}:`, err);
      try {
        const restored = await deps.runs.restoreRecoveredRun(item.id, item.previousStatus);
        if (!restored) {
          console.error(`[workwell] restoreRecoveredRun returned false for ${item.id}: row not updated`);
        }
      } catch (restoreErr) {
        console.error(`[workwell] restoreRecoveredRun threw for ${item.id}:`, restoreErr);
      }
    }

    if (auditFailed) {
      await emitAlert(channels, {
        kind: "RUN_RECOVERED",
        at: new Date().toISOString(),
        status: "FAILED",
        runId: item.id,
        message: `Recovery audit failed for run ${item.id}; restored to ${item.previousStatus} for retry`,
      });
    } else {
      successful.push(item);
      // Best-effort alert — never let observability fail boot recovery.
      await emitAlert(channels, {
        kind: "RUN_RECOVERED",
        at: new Date().toISOString(),
        status: "FAILED",
        runId: item.id,
        message: isQueued
          ? `Stuck run ${item.id} recovered as FAILED (unclaimed QUEUED run timed out)`
          : `Stuck run ${item.id} recovered as FAILED (orphaned by container restart)`,
      });
    }
  }
  return successful;
}
