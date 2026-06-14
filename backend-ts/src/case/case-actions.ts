/**
 * Case actions (#107) — TS port of CaseFlowService.assignCase / escalateCase.
 *
 * Each action: load the case → patch the row → write a case_action AND an audit_event
 * (CLAUDE.md: every state change writes audit_event), with payloads matching the Java
 * shapes so the timeline + the unchanged frontend render identically. Returns the
 * refreshed CaseDetail (incl. evidence + merged timeline), or null when the case is
 * unknown (the route turns that into a 404).
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
  return toCaseDetail(c, outcome, timeline);
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
  await deps.cases.patchCase(caseId, { assignee: normalized });

  const payload = {
    assignee: normalized ?? "unassigned",
    previousAssignee: existing.assignee ?? "unassigned",
  };
  await deps.events.insertAction({ caseId, actionType: "ASSIGNED", actor, payload });
  await deps.events.appendAudit({
    eventType: "CASE_ASSIGNED",
    entityType: "case",
    entityId: caseId,
    actor,
    refRunId: existing.lastRunId,
    refCaseId: caseId,
    refMeasureVersionId: existing.measureId,
    payload,
  });
  return buildDetail(deps, caseId);
}

/** Escalate: force priority HIGH + status OPEN with the supervisor-queue next action. */
export async function escalateCase(deps: CaseActionDeps, caseId: string, actor: string): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  await deps.cases.patchCase(caseId, { priority: "HIGH", status: "OPEN", nextAction: ESCALATION_NEXT_ACTION });

  const payload = {
    priority: "HIGH",
    status: "OPEN",
    nextAction: ESCALATION_NEXT_ACTION,
    reason: "Manual escalation requested",
  };
  await deps.events.insertAction({ caseId, actionType: "ESCALATED", actor, payload });
  await deps.events.appendAudit({
    eventType: "CASE_ESCALATED",
    entityType: "case",
    entityId: caseId,
    actor,
    refRunId: existing.lastRunId,
    refCaseId: caseId,
    refMeasureVersionId: existing.measureId,
    payload,
  });
  return buildDetail(deps, caseId);
}
