/**
 * Boot recovery for runs orphaned by a container restart (#109 pre-retirement hardening).
 *
 * An ALL_PROGRAMS/SITE run is advanced by an in-process `ctx.waitUntil` task that does NOT survive a
 * restart (every push to `main` redeploys), so a run interrupted mid-flight is stuck RUNNING forever.
 * `RunStore.failStuckRuns` flips such runs to FAILED; this wraps it to ALSO write a `RUN_RECOVERED`
 * audit_event per recovered run. The store has no events binding, and "every state change writes an
 * audit_event — no exceptions" is a hard rule (AGENTS.md / CLAUDE.md), so the audit lives here, above
 * the store, where both the run store and the events store are in scope.
 */
import type { RunStore, RecoveredRun } from "../stores/run-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { emitAlert, resolveAlertChannels, type AlertChannel } from "./alert-channel.ts";

export interface RecoverStuckRunsDeps {
  runs: RunStore;
  events: CaseEventStore;
  /** Optional alert fan-out (#264). Default = console-only when omitted. */
  alertChannels?: readonly AlertChannel[];
}

/**
 * Fail + audit any runs stuck RUNNING or unclaimed QUEUED beyond their respective thresholds (see
 * {@link RunStore.failStuckRuns}). Returns the recovered runs with their previous status.
 * Best-effort: callers run it fire-and-forget on boot. Emits one WORKWELL_ALERT per recovered run
 * (#264) so orphaned failures are not silent.
 */
export async function recoverStuckRuns(
  deps: RecoverStuckRunsDeps,
  olderThanMs?: number,
  unclaimedQueuedOlderThanMs?: number,
): Promise<RecoveredRun[]> {
  const recovered = await deps.runs.failStuckRuns(olderThanMs, unclaimedQueuedOlderThanMs);
  const channels = deps.alertChannels ?? resolveAlertChannels({});
  for (const item of recovered) {
    const isQueued = item.previousStatus === "QUEUED";
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
      // Per-run, not per-sweep: one transient audit failure must not leave the runs after it
      // unaudited, and the alert below still fires so the failed write is not silent either.
      console.error(`[workwell] RUN_RECOVERED audit failed for ${item.id}:`, err);
    }
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
  return recovered;
}
