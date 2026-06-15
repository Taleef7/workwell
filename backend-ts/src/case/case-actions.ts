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

/** 400 — an action precondition failed (e.g. resolving a non-open case, missing closure note). */
export class CaseActionError extends Error {}

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

const MANUAL_RESOLVE_NEXT_ACTION = "Manually resolved by case manager/admin.";

/**
 * Manually resolve (CLOSE) an OPEN/IN_PROGRESS case with a required closure note. Throws
 * CaseActionError (→ 400) on a bad state/note; returns null when the case is unknown (→ 404).
 */
export async function resolveCase(
  deps: CaseActionDeps,
  caseId: string,
  note: string | null,
  resolvedAt: string | null,
  actor: string,
): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  if (existing.status !== "OPEN" && existing.status !== "IN_PROGRESS") {
    throw new CaseActionError("Only OPEN or IN_PROGRESS cases can be manually resolved");
  }
  const trimmedNote = (note ?? "").trim();
  if (trimmedNote === "") throw new CaseActionError("Closure note is required");

  // resolvedAt is optional, but if a client supplies one it must parse — a typo must 400, not
  // silently record the current time as the closure timestamp (mirrors SCHEDULE_APPOINTMENT).
  let effectiveResolvedAt: string;
  if (resolvedAt !== null && resolvedAt.trim() !== "") {
    const parsed = new Date(resolvedAt);
    if (Number.isNaN(parsed.getTime())) throw new CaseActionError("resolvedAt is not a valid timestamp");
    effectiveResolvedAt = parsed.toISOString();
  } else {
    effectiveResolvedAt = new Date().toISOString();
  }

  const payload = { note: trimmedNote, resolvedAt: effectiveResolvedAt, resolvedBy: actor, closedReason: "MANUAL_RESOLVE" };
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "RESOLVE", actor, payload: { type: "RESOLVE", ...payload } },
    audit: {
      eventType: "CASE_MANUALLY_CLOSED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: existing.lastRunId,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload: { caseId, ...payload },
    },
  });
  await deps.cases.patchCase(caseId, {
    status: "CLOSED",
    nextAction: MANUAL_RESOLVE_NEXT_ACTION,
    closedAt: effectiveResolvedAt,
    closedReason: "MANUAL_RESOLVE",
    closedBy: actor,
  });
  return buildDetail(deps, caseId);
}
