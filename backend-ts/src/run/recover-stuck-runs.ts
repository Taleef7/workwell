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
}

/**
 * Fail + audit any runs stuck RUNNING or unclaimed QUEUED beyond their respective thresholds (see
 * {@link RunStore.failStuckRuns}). Returns the successfully recovered and audited runs with their
 * previous status. Runs whose audit write fails are compensated by restoring them to their previous
 * status for retry on the next sweep and excluded from the return value.
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
