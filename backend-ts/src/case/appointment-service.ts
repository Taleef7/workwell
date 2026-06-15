/**
 * Appointment service (#108) — TS port of CaseFlowService.scheduleAppointment / listAppointments.
 *
 * Schedule writes the appointment row + a case_action + an audit_event (APPOINTMENT_SCHEDULED, the
 * action + audit atomic via recordCaseEvent — CLAUDE.md audit invariant), moves an OPEN case to
 * IN_PROGRESS, and returns the refreshed CaseDetail. (Java also wrote an outreach_records reminder
 * row; TS has no outreach_records table — outreach is modeled as case_actions — so that side is
 * omitted; the SCHEDULE_APPOINTMENT case_action carries the same intent on the timeline.)
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { AppointmentStore } from "../stores/appointment-store.ts";
import { toCaseDetail, type CaseDetail } from "./case-detail-read-model.ts";

/** 400 — missing/invalid appointment fields. */
export class AppointmentError extends Error {}

export interface AppointmentDeps {
  appointments: AppointmentStore;
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
}

export interface ScheduleInput {
  appointmentType: string | null;
  scheduledAt: string | null;
  location: string | null;
  notes: string | null;
}

async function buildDetail(deps: AppointmentDeps, caseId: string): Promise<CaseDetail | null> {
  const c = await deps.cases.getCase(caseId);
  if (!c) return null;
  const outcomes = await deps.outcomes.listOutcomes(c.lastRunId);
  const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
  const timeline = await deps.events.caseTimeline(caseId);
  const latest = await deps.events.latestOutreachDeliveryStatus(caseId);
  return toCaseDetail(c, outcome, timeline, latest);
}

export async function scheduleAppointment(
  deps: AppointmentDeps,
  caseId: string,
  input: ScheduleInput,
  actor: string,
): Promise<CaseDetail | null> {
  const appointmentType = input.appointmentType?.trim();
  const location = input.location?.trim();
  if (!appointmentType) throw new AppointmentError("appointmentType is required");
  if (!input.scheduledAt || Number.isNaN(new Date(input.scheduledAt).getTime())) {
    throw new AppointmentError("scheduledAt is required");
  }
  if (!location) throw new AppointmentError("location is required");

  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;

  const scheduledAt = new Date(input.scheduledAt).toISOString();
  const notes = input.notes && input.notes.trim() !== "" ? input.notes.trim() : null;
  const appointmentId = crypto.randomUUID();

  await deps.appointments.insert({
    id: appointmentId,
    caseId,
    employeeId: existing.employeeId,
    measureId: existing.measureId,
    appointmentType,
    scheduledAt,
    location,
    status: "PENDING",
    notes,
    createdBy: actor,
  });

  const payload = { appointmentId, appointmentType, scheduledAt, location, notes: notes ?? "" };
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "SCHEDULE_APPOINTMENT", actor, payload: { type: "SCHEDULE_APPOINTMENT", ...payload } },
    audit: {
      eventType: "APPOINTMENT_SCHEDULED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: existing.lastRunId,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload,
    },
  });

  // An OPEN case moves to IN_PROGRESS; otherwise just bump updated_at (Java parity).
  await deps.cases.patchCase(caseId, existing.status === "OPEN" ? { status: "IN_PROGRESS" } : {});
  return buildDetail(deps, caseId);
}

export async function listAppointments(deps: AppointmentDeps, caseId: string) {
  return deps.appointments.listByCase(caseId);
}
