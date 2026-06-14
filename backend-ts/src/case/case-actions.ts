/**
 * Case actions (#107) — TS port of CaseFlowService.assignCase / escalateCase.
 *
 * Each action: load the case → write the case_action + audit_event ATOMICALLY
 * (recordCaseEvent) → THEN patch the case row → return the refreshed CaseDetail
 * (incl. evidence + merged timeline), or null when the case is unknown (→ 404).
 *
 * Event-before-patch ordering is deliberate and upholds the hard audit invariant
 * (CLAUDE.md: every state change writes audit_event — no exceptions). The stores
 * issue separately-committed statements, so if events were written AFTER the patch a
 * mid-action failure could leave a changed case with no ledger entry. Writing the
 * (atomic) event first means a failure can only ever leave a recorded-but-unapplied
 * action — never an unaudited state change. Payloads match the Java CaseFlowService
 * shapes so the timeline + the unchanged frontend render identically.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { toCaseDetail, type CaseDetail } from "./case-detail-read-model.ts";

const ESCALATION_NEXT_ACTION = "Escalated to supervisor queue for immediate handling.";

export interface CaseActionDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
}

async function buildDetail(deps: CaseActionDeps, caseId: string): Promise<CaseDetail | null> {
  const c = await deps.cases.getCase(caseId);
  if (!c) return null;
  const outcomes = await deps.outcomes.listOutcomes(c.lastRunId);
  const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
  const timeline = await deps.events.caseTimeline(caseId);
  const latest = await deps.events.latestOutreachDeliveryStatus(caseId);
  return toCaseDetail(c, outcome, timeline, latest);
}

/** Assign (or clear, when `assignee` is blank) the case owner. */
export async function assignCase(
  deps: CaseActionDeps,
  caseId: string,
  assignee: string | null,
  actor: string,
): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  const normalized = assignee && assignee.trim() ? assignee.trim() : null;

  const payload = {
    assignee: normalized ?? "unassigned",
    previousAssignee: existing.assignee ?? "unassigned",
  };
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "ASSIGNED", actor, payload },
    audit: {
      eventType: "CASE_ASSIGNED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: existing.lastRunId,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload,
    },
  });
  await deps.cases.patchCase(caseId, { assignee: normalized });
  return buildDetail(deps, caseId);
}

/** Escalate: force priority HIGH + status OPEN with the supervisor-queue next action. */
export async function escalateCase(deps: CaseActionDeps, caseId: string, actor: string): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;

  const payload = {
    priority: "HIGH",
    status: "OPEN",
    nextAction: ESCALATION_NEXT_ACTION,
    reason: "Manual escalation requested",
  };
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "ESCALATED", actor, payload },
    audit: {
      eventType: "CASE_ESCALATED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: existing.lastRunId,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload,
    },
  });
  await deps.cases.patchCase(caseId, { priority: "HIGH", status: "OPEN", nextAction: ESCALATION_NEXT_ACTION });
  return buildDetail(deps, caseId);
}
