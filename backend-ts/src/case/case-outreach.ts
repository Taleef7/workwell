/**
 * Case outreach (#107) — TS port of CaseFlowService.previewOutreach / sendOutreach /
 * updateOutreachDelivery. Templates resolve via `resolveTemplate` (#150 M1 — parity with Java's
 * resolveForOutcome): an explicit, known templateId wins; otherwise the case's OUTCOME bucket
 * (OVERDUE/MISSING_DATA/DUE_SOON) chooses a fitting message, falling back to the generic reminder.
 * (The DB-backed outreach_templates + admin CRUD live in the admin module; an unknown templateId
 * falls through to the outcome default here, matching Java's resolveByIdOrDefault fallback.)
 *
 * Send/delivery are state-changing, so they follow the same event-before-patch
 * ordering as the other actions (recordCaseEvent writes the case_action + audit_event
 * atomically before the case row is patched) — upholding the hard audit invariant.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { toCaseDetail, type CaseDetail } from "./case-detail-read-model.ts";
import { simulatedEmailService, type EmailService } from "./email-service.ts";

interface OutreachTemplateContent {
  id: string | null;
  name: string;
  subject: string;
  bodyText: string;
}

// Outreach templates keyed by NAME/id to mirror the Java seeds (V007/V008), so both stacks select the
// SAME template per (outcome, measure) — see templateForOutcome (#150 M1). Bodies use {{...}} placeholders
// (rendered per case) so the message stays measure-specific.
const TEMPLATES = {
  general: {
    id: "11111111-0000-0000-0000-000000000003",
    name: "General Compliance Reminder",
    subject: "Outreach Reminder for {{measureName}}",
    bodyText: "Hello {{employeeName}}, please review your pending {{measureName}} requirement and complete the required follow-up as soon as possible.",
  },
  hearing: {
    id: "11111111-0000-0000-0000-000000000001",
    name: "Hearing Conservation Overdue Outreach",
    subject: "Action Needed: {{measureName}} Follow-up",
    bodyText: "Hello {{employeeName}}, your {{measureName}} requirement needs attention. Please coordinate with occupational health to schedule it.",
  },
  tb: {
    id: "11111111-0000-0000-0000-000000000002",
    name: "TB Surveillance Follow-Up",
    subject: "Upcoming {{measureName}} Due Date",
    bodyText: "Hello {{employeeName}}, your {{measureName}} screening is due soon. Please book your screening within the compliance window.",
  },
  missing: {
    id: "11111111-0000-0000-0000-000000000005",
    name: "Missing Data Follow-Up",
    subject: "Action Needed: Missing Documentation for {{measureName}}",
    bodyText: "Hello {{employeeName}}, we could not complete your {{measureName}} review because documentation is missing. Please provide the required records or contact the clinic for assistance.",
  },
} satisfies Record<string, OutreachTemplateContent>;

const DEFAULT_TEMPLATE: OutreachTemplateContent = TEMPLATES.general;

/**
 * Outcome-aware default template (#150 M1) — mirrors Java `OutreachTemplateService.templateNameForOutcome`
 * so the two stacks (and the manual + auto-notification paths) pick the SAME template:
 *   MISSING_DATA → missing-data; DUE_SOON → the measure's reminder (hearing/TB, else general);
 *   OVERDUE/other → the generic General Compliance Reminder (never a measure-specific body).
 */
function templateForOutcome(outcomeStatus: string | null | undefined, measureName: string | null | undefined): OutreachTemplateContent {
  const outcome = (outcomeStatus ?? "").trim().toUpperCase();
  const measure = (measureName ?? "").toLowerCase();
  if (outcome === "MISSING_DATA") return TEMPLATES.missing;
  if (outcome === "DUE_SOON") {
    if (measure.includes("audiogram") || measure.includes("hearing")) return TEMPLATES.hearing;
    if (measure.includes("tb")) return TEMPLATES.tb;
    return TEMPLATES.general;
  }
  return TEMPLATES.general; // OVERDUE + everything else → generic
}

/** Look up a built-in template by its seeded id (V007/V008), else null. */
function templateById(templateId: string | null | undefined): OutreachTemplateContent | null {
  if (!templateId) return null;
  return Object.values(TEMPLATES).find((t) => t.id === templateId) ?? null;
}

/**
 * Resolve the template to send (#150 M1 — parity with Java `resolveForOutcome`): an explicit, known
 * templateId wins; otherwise fall back to the outcome-aware default. An unknown id falls through to
 * the outcome default (Java's resolveByIdOrDefault behavior).
 */
function resolveTemplate(
  templateId: string | null | undefined,
  outcomeStatus: string | null | undefined,
  measureName: string | null | undefined,
): OutreachTemplateContent {
  return templateById(templateId) ?? templateForOutcome(outcomeStatus, measureName);
}

export interface OutreachPreview {
  templateId: string | null;
  templateName: string;
  subject: string;
  bodyText: string;
  employeeName: string;
  measureName: string;
  dueDate: string;
}

export interface OutreachDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
  email?: EmailService;
}

const DELIVERY_STATUSES = ["QUEUED", "SENT", "FAILED", "SIMULATED"];

function renderTemplate(
  raw: string,
  employeeName: string,
  measureName: string,
  dueDate: string,
  outcomeStatus: string,
): string {
  return raw
    .replaceAll("{{employeeName}}", employeeName)
    .replaceAll("{{measureName}}", measureName)
    .replaceAll("{{dueDate}}", dueDate)
    .replaceAll("{{outcomeStatus}}", outcomeStatus);
}

/** Due date = last_exam_date + compliance_window_days from why_flagged, else the evaluation period. */
function computeDueDate(evidence: Record<string, unknown>, evaluationPeriod: string): string {
  const why = evidence?.why_flagged as Record<string, unknown> | undefined;
  const lastExam = why?.last_exam_date;
  const window = why?.compliance_window_days;
  if (typeof lastExam !== "string" || lastExam.length < 10 || window == null) return evaluationPeriod;
  const windowDays = Number(window);
  if (!Number.isFinite(windowDays)) return evaluationPeriod;
  const d = new Date(`${lastExam.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return evaluationPeriod;
  d.setUTCDate(d.getUTCDate() + windowDays);
  return d.toISOString().slice(0, 10);
}

async function loadOutcomeEvidence(deps: OutreachDeps, lastRunId: string, employeeId: string, measureId: string) {
  const outcomes = await deps.outcomes.listOutcomes(lastRunId);
  return outcomes.find((o) => o.subjectId === employeeId && o.measureId === measureId) ?? null;
}

async function buildDetail(deps: OutreachDeps, caseId: string): Promise<CaseDetail | null> {
  const c = await deps.cases.getCase(caseId);
  if (!c) return null;
  const outcome = await loadOutcomeEvidence(deps, c.lastRunId, c.employeeId, c.measureId);
  const timeline = await deps.events.caseTimeline(caseId);
  const latest = await deps.events.latestOutreachDeliveryStatus(caseId);
  return toCaseDetail(c, outcome, timeline, latest);
}

/**
 * Resolve the render context (employee/measure names + due date) from the DERIVED case
 * detail — matching Java, which reads `loadCase(...).evidenceJson().why_flagged` so the due
 * date is last_exam_date + window (the raw stored outcome evidence has no why_flagged block).
 */
async function renderContext(deps: OutreachDeps, c: { lastRunId: string; employeeId: string; measureId: string; evaluationPeriod: string }) {
  const outcome = await loadOutcomeEvidence(deps, c.lastRunId, c.employeeId, c.measureId);
  const detail = toCaseDetail(c as never, outcome);
  return {
    employeeName: detail.employeeName,
    measureName: detail.measureName,
    dueDate: computeDueDate(detail.evidenceJson, c.evaluationPeriod),
  };
}

/** Render the default outreach message for the case (no state change). */
export async function previewOutreach(
  deps: OutreachDeps,
  caseId: string,
  templateId?: string | null,
): Promise<OutreachPreview | null> {
  const c = await deps.cases.getCase(caseId);
  if (!c) return null;
  const { employeeName, measureName, dueDate } = await renderContext(deps, c);
  const t = resolveTemplate(templateId, c.currentOutcomeStatus, measureName);
  return {
    templateId: t.id,
    templateName: t.name,
    subject: renderTemplate(t.subject, employeeName, measureName, dueDate, c.currentOutcomeStatus),
    bodyText: renderTemplate(t.bodyText, employeeName, measureName, dueDate, c.currentOutcomeStatus),
    employeeName,
    measureName,
    dueDate,
  };
}

/** Send (simulated) outreach: record the action+audit, then set the case OPEN with a follow-up next action. */
export async function sendOutreach(
  deps: OutreachDeps,
  caseId: string,
  actor: string,
  templateId?: string | null,
): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  const email = deps.email ?? simulatedEmailService;
  const { employeeName, measureName, dueDate } = await renderContext(deps, existing);
  const t = resolveTemplate(templateId, existing.currentOutcomeStatus, measureName);
  const subject = renderTemplate(t.subject, employeeName, measureName, dueDate, existing.currentOutcomeStatus);
  const body = renderTemplate(t.bodyText, employeeName, measureName, dueDate, existing.currentOutcomeStatus);
  const toAddress = `${existing.employeeId}@workwell-demo.dev`; // deterministic, non-routable
  const delivery = email.send(toAddress, subject, body);

  const nextAction = "Wait for employee follow-up, then rerun to verify closure.";
  const actionPayload = {
    autoTriggered: false,
    channel: "SIMULATED_EMAIL",
    template: t.name,
    templateName: t.name,
    templateId: t.id,
    subject,
    deliveryStatus: delivery.status,
    note: `Outreach dispatched via ${delivery.provider} provider (${delivery.status}).`,
    emailMessageId: delivery.messageId,
    deliveryProvider: delivery.provider,
    emailDeliveryStatus: delivery.status,
    toAddress: delivery.toAddress,
    sentAt: delivery.sentAt,
  };
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "OUTREACH_SENT", actor, payload: actionPayload },
    audit: {
      eventType: "CASE_OUTREACH_SENT",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: existing.lastRunId,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload: {
        caseStatus: "OPEN",
        nextAction,
        outcomeStatus: existing.currentOutcomeStatus,
        action: actionPayload,
      },
    },
  });
  await deps.cases.patchCase(caseId, { status: "OPEN", nextAction });
  return buildDetail(deps, caseId);
}

/** Update the delivery state of a sent outreach. Throws on an invalid status or before a send. */
export async function updateOutreachDelivery(
  deps: OutreachDeps,
  caseId: string,
  deliveryStatus: string,
  actor: string,
): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  if (!(await deps.events.hasOutreachSent(caseId))) {
    throw new OutreachError("Cannot update delivery state before outreach is sent");
  }
  if (!deliveryStatus || !deliveryStatus.trim()) throw new OutreachError("deliveryStatus is required");
  const normalized = deliveryStatus.trim().toUpperCase();
  if (!DELIVERY_STATUSES.includes(normalized)) {
    throw new OutreachError("deliveryStatus must be one of QUEUED, SENT, FAILED, SIMULATED");
  }
  const nextAction =
    normalized === "FAILED"
      ? "Retry outreach delivery or escalate if contact path remains blocked."
      : normalized === "SENT"
        ? "Wait for employee response, then rerun to verify closure."
        : "Outreach queued for delivery.";

  const updatedAt = new Date().toISOString();
  const payload = {
    deliveryStatus: normalized,
    updatedAt,
    actor,
    note: "Simulated delivery-state transition.",
  };
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "OUTREACH_DELIVERY_UPDATED", actor, payload },
    audit: {
      eventType: "CASE_OUTREACH_DELIVERY_UPDATED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: existing.lastRunId,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload: { caseId, deliveryStatus: normalized, updatedAt, actor },
    },
  });
  await deps.cases.patchCase(caseId, { nextAction });
  return buildDetail(deps, caseId);
}

/** A bad-request-class outreach failure (the route maps this to HTTP 400). */
export class OutreachError extends Error {}
