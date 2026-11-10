import { ACTIVE_CASE_STATUSES } from "../case/case-logic.ts";
import type { CaseRecord, CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { RunStore } from "../stores/run-store.ts";

/**
 * Close the still-active cases of measures this deployment has retired (#889).
 *
 * A retired measure is no longer evaluated, so nothing else would ever touch its cases again: the cycle
 * rollover closes only measures a run evaluated, and a case of a measure nobody runs would sit OPEN on
 * the work list, the patient page and every open-gap count for good. CMS137 is the first: the CY2027
 * final rule (CMS-1848-F) removed Quality ID 305 from APP Plus, and the owner retired it on Maui.
 *
 * A system closure (`closed_by` NULL), like the rollover: `RESOLVED`, `closed_reason='MEASURE_RETIRED'`.
 * Audit-first, per case, in this order:
 *  1. re-read the case and skip it unless it is still active, so a case staff closed since the list was
 *     read gets no false event;
 *  2. write `CASE_RESOLVED` — if that fails the case stays open and the next run tries again;
 *  3. patch the case — if that fails the event over-claims (and the next run writes a second one), which
 *     is the direction the ledger errs in (DATA_MODEL_CONTRACTS §4).
 *
 * There is no compare-and-set on the patch (the rollover's gap too); step 1 narrows the window. Best-effort:
 * nothing here throws, so a finished run is never stranded. Idempotent: a second pass finds nothing.
 */

export const MEASURE_RETIRED = "MEASURE_RETIRED";

/** Why, in the audit payload. One line per retired measure; a measure missing here gets the generic line. */
const RETIRED_BASIS: Readonly<Record<string, string>> = {
  cms137: "CMS-1848-F (the CY2027 Physician Fee Schedule final rule) removed Quality ID 305 from APP Plus",
};

export interface RetiredClosureResult {
  closed: number;
  /** Audited, then the patch failed: still open, with an event that says closed. */
  failed: number;
  /** The audit write failed, so the case was left open untouched. */
  auditGaps: number;
  /** Measures whose active cases could not be listed; none of them was closed. */
  unreadMeasures: string[];
  ms: number;
}

export interface RetiredClosureDeps {
  caseStore: Pick<CaseStore, "listCases" | "getCase" | "patchCase">;
  events: Pick<CaseEventStore, "appendAudit">;
  runStore?: Pick<RunStore, "appendLog">;
}

export async function closeRetiredMeasureCases(
  deps: RetiredClosureDeps,
  input: { retiredMeasureIds: readonly string[]; runId: string | null; actor: string; now?: () => string },
): Promise<RetiredClosureResult> {
  const started = Date.now();
  const now = input.now ?? (() => new Date().toISOString());
  const result: RetiredClosureResult = { closed: 0, failed: 0, auditGaps: 0, unreadMeasures: [], ms: 0 };
  const isActive = (c: CaseRecord | null): c is CaseRecord =>
    c !== null && (ACTIVE_CASE_STATUSES as readonly string[]).includes(c.status);

  for (const measureId of input.retiredMeasureIds) {
    let active: CaseRecord[];
    try {
      active = await deps.caseStore.listCases({ measureId, statuses: [...ACTIVE_CASE_STATUSES], limit: 100000 });
    } catch {
      result.unreadMeasures.push(measureId);
      continue;
    }
    for (const listed of active) {
      const current = await deps.caseStore.getCase(listed.id).catch(() => null);
      if (!isActive(current)) continue;
      try {
        await deps.events.appendAudit({
          eventType: "CASE_RESOLVED",
          entityType: "case",
          entityId: current.id,
          actor: input.actor,
          refRunId: input.runId,
          refCaseId: current.id,
          refMeasureVersionId: measureId,
          payload: {
            reason: MEASURE_RETIRED,
            measureId,
            subjectId: current.employeeId,
            evaluationPeriod: current.evaluationPeriod,
            priorStatus: current.status,
            runId: input.runId,
            basis: RETIRED_BASIS[measureId] ?? "the deployment no longer runs this measure",
          },
        });
      } catch {
        result.auditGaps++;
        continue;
      }
      const patched = await deps.caseStore
        .patchCase(current.id, { status: "RESOLVED", closedAt: now(), closedReason: MEASURE_RETIRED, closedBy: null })
        .catch(() => null);
      if (patched) result.closed++;
      else result.failed++;
    }
  }
  result.ms = Date.now() - started;

  const touched = result.closed + result.failed + result.auditGaps + result.unreadMeasures.length > 0;
  if (touched && deps.runStore && input.runId) {
    const problems = result.failed + result.auditGaps + result.unreadMeasures.length > 0;
    await deps.runStore
      .appendLog(
        input.runId,
        problems ? "WARN" : "INFO",
        `Closed ${result.closed} case(s) of a retired measure (${input.retiredMeasureIds.join(", ")}) in ${(result.ms / 1000).toFixed(1)} s` +
          (result.failed > 0 ? `; ${result.failed} have a closing audit event but could not be closed and stay open` : "") +
          (result.auditGaps > 0 ? `; ${result.auditGaps} could not be audited and were left open` : "") +
          (result.unreadMeasures.length > 0 ? `; the open cases of ${result.unreadMeasures.join(", ")} could not be read` : "") +
          ".",
      )
      .catch(() => {});
  }
  return result;
}

/** Whether a pass changed or tried to change anything, so `RUN_COMPLETED` carries its counts. */
export const retiredClosureTouched = (r: RetiredClosureResult): boolean =>
  r.closed + r.failed + r.auditGaps + r.unreadMeasures.length > 0;
