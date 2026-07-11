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
import type { RunStore } from "../stores/run-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { emitAlert, resolveAlertChannels, type AlertChannel } from "./alert-channel.ts";

export interface RecoverStuckRunsDeps {
  runs: RunStore;
  events: CaseEventStore;
  /** Optional alert fan-out (#264). Default = console-only when omitted. */
  alertChannels?: readonly AlertChannel[];
}

/**
 * Fail + audit any runs stuck RUNNING beyond the threshold (see {@link RunStore.failStuckRuns};
 * QUEUED runs are left for the claim path). Returns the recovered run ids. Best-effort: callers run
 * it fire-and-forget on boot. Emits one WORKWELL_ALERT per recovered run (#264) so orphaned failures
 * are not silent.
 */
export async function recoverStuckRuns(deps: RecoverStuckRunsDeps, olderThanMs?: number): Promise<string[]> {
  const recovered = await deps.runs.failStuckRuns(olderThanMs);
  const channels = deps.alertChannels ?? resolveAlertChannels({});
  for (const runId of recovered) {
    await deps.events.appendAudit({
      eventType: "RUN_RECOVERED",
      entityType: "run",
      entityId: runId,
      actor: "system",
      refRunId: runId,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: {
        reason:
          "Orphaned by a container restart (the in-process run job did not survive); failed by boot recovery.",
      },
    });
    // Best-effort alert — never let observability fail boot recovery.
    await emitAlert(channels, {
      kind: "RUN_RECOVERED",
      at: new Date().toISOString(),
      status: "FAILED",
      runId,
      message: `Stuck run ${runId} recovered as FAILED (orphaned by container restart)`,
    });
  }
  return recovered;
}
