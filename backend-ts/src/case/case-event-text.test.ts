/**
 * The words for each case event (#865), from the payload shapes the writers actually record.
 *   node --import tsx --test src/case/case-event-text.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCaseEvent, fallbackCaseEventLabel } from "./case-event-text.ts";

const say = (eventType: string, payload: Record<string, unknown> | null) => describeCaseEvent({ eventType, payload }, "America/New_York");

test("an assignment says to whom, from whom, and how — as each writer records it", () => {
  // case-actions.ts: one case, the string "unassigned" for nobody.
  assert.deepEqual(say("CASE_ASSIGNED", { assignee: "staff@x", previousAssignee: "unassigned" }), {
    label: "Assigned",
    summary: "Assigned to staff@x (was unassigned)",
  });
  assert.equal(say("CASE_ASSIGNED", { assignee: "unassigned", previousAssignee: "staff@x" }).summary, "Unassigned (was staff@x)");
  // worklist.ts bulk: null for nobody.
  assert.equal(
    say("CASE_ASSIGNED", { assignee: "lead@x", previousAssignee: null, bulk: true }).summary,
    "Assigned to lead@x (was unassigned), in a bulk assignment",
  );
  // panel-assignment.ts: bulk AND a panel; the panel is what a person needs to know.
  assert.equal(
    say("CASE_ASSIGNED", { assignee: "staff@x", previousAssignee: "lead@x", bulk: true, panel: "prov-7", reason: "PANEL_RECONCILED" }).summary,
    "Assigned to staff@x (was lead@x), from the provider's panel",
  );
  // An old row without previousAssignee says nothing about it rather than "was unassigned".
  assert.equal(say("CASE_ASSIGNED", { assignee: "staff@x" }).summary, "Assigned to staff@x");
});

test("run-created events: opened, re-checked, reopened, and each way a case closes", () => {
  assert.deepEqual(say("CASE_CREATED", { disposition: "CREATED", outcomeStatus: "DUE_SOON", status: "OPEN" }), {
    label: "Created",
    summary: "Opened as due soon",
  });
  assert.equal(
    say("CASE_CREATED", { outcomeStatus: "OVERDUE", assignee: "staff@x", assignmentSource: "PANEL" }).summary,
    "Opened as overdue, assigned to staff@x from the provider's panel",
  );
  assert.equal(say("CASE_UPDATED", { disposition: "UPDATED", outcomeStatus: "MISSING_DATA" }).summary, "The latest run found it missing data");
  assert.deepEqual(say("CASE_UPDATED", { disposition: "REOPENED", outcomeStatus: "OVERDUE" }), {
    label: "Reopened",
    summary: "Reopened: the latest run found it overdue",
  });
  assert.equal(say("CASE_RESOLVED", { disposition: "RESOLVED", outcomeStatus: "COMPLIANT", closedReason: "AUTO_RESOLVED" }).summary, "Closed: the latest run found the measure met");
  assert.equal(say("CASE_RESOLVED", { disposition: "RESOLVED", closedReason: "OUT_OF_POPULATION" }).summary, "Closed: no longer in this measure's population");
  assert.equal(say("CASE_RESOLVED", { status: "COMPLIANT", summary: "Case closed by rerun-to-verify…", runId: "r" }).summary, "Closed: a re-check found the measure met");
  assert.equal(
    say("CASE_RESOLVED", { reason: "CYCLE_ROLLED_OVER", priorPeriod: "2026-01-01", currentPeriod: "2027-01-01" }).summary,
    "Closed: a new measurement period began (2026-01-01 to 2027-01-01)",
  );
  assert.equal(say("CASE_EXCLUDED", { exclusionReason: "Excluded on verification rerun." }).summary, "Excluded on verification rerun.");
  assert.equal(say("CASE_EXCLUDED", { disposition: "EXCLUDED" }).summary, "Closed as excluded");
});

test("operator actions: escalate, close, re-check", () => {
  assert.equal(say("CASE_ESCALATED", { priority: "HIGH", status: "OPEN", reason: "Manual escalation requested" }).summary, "Priority raised to High");
  assert.equal(say("CASE_MANUALLY_CLOSED", { note: "Done at another practice", closedReason: "MANUAL_RESOLVE" }).summary, "Closed with the note: Done at another practice");
  assert.deepEqual(say("CASE_RERUN_VERIFIED", { priorOutcomeStatus: "OVERDUE", verifiedStatus: "COMPLIANT" }), {
    label: "Re-checked",
    summary: "Re-checked: was overdue, now compliant",
  });
  assert.equal(say("CASE_RERUN_FAILED", { caseUnchanged: true }).label, "Re-check Failed");
});

test("outreach reads its detail from the nested action, and says when it was automatic", () => {
  const sent = say("CASE_OUTREACH_SENT", {
    caseStatus: "OPEN",
    action: { autoTriggered: false, channel: "EMAIL", templateName: "Screening reminder", deliveryStatus: "SIMULATED" },
  });
  assert.deepEqual(sent, { label: "Outreach Sent", summary: "Screening reminder sent by email, delivery simulated" });
  assert.equal(
    say("CASE_OUTREACH_SENT", { action: { autoTriggered: true, channel: "SMS" } }).summary,
    "Sent by sms (automatic)",
  );
  assert.equal(say("CASE_OUTREACH_DELIVERY_UPDATED", { deliveryStatus: "FAILED" }).summary, "Delivery failed");
});

test("appointments name the practice's zone; an unreadable time is left out, never printed raw", () => {
  const s = say("APPOINTMENT_SCHEDULED", { appointmentType: "Mammogram", scheduledAt: "2026-11-03T15:00:00.000Z", location: "Wailuku Clinic" }).summary!;
  assert.match(s, /^Mammogram scheduled for Nov 3, 2026, 10:00\s?AM EST at Wailuku Clinic$/);
  assert.equal(say("APPOINTMENT_SCHEDULED", { appointmentType: "Mammogram", scheduledAt: "soon", location: "Clinic" }).summary, "Mammogram scheduled at Clinic");
});

test("an appointment's notes are in its sentence; the writer's empty notes add nothing", () => {
  // Staff typed these, and with the payload hidden from them the sentence is where they read them.
  assert.equal(
    say("APPOINTMENT_SCHEDULED", { appointmentType: "Mammogram", scheduledAt: "soon", location: "Clinic", notes: "Bring prior films" }).summary,
    "Mammogram scheduled at Clinic, with the note: Bring prior films",
  );
  // `scheduleAppointment` writes `notes: ""` when none were typed.
  assert.equal(say("APPOINTMENT_SCHEDULED", { appointmentType: "Mammogram", scheduledAt: "soon", location: "Clinic", notes: "" }).summary, "Mammogram scheduled at Clinic");
});

test("evidence and the AI explanation", () => {
  assert.equal(say("EVIDENCE_UPLOADED", { fileName: "result.pdf", description: "" }).summary, "Uploaded result.pdf");
  assert.equal(say("EVIDENCE_DOWNLOADED", { fileName: "result.pdf" }).summary, "Downloaded result.pdf");
  // The writer's real shape (`insertAiAudit`): the surface's fields sit under `payload`, not at the top.
  const ai = (fallbackUsed: boolean) => ({ timestamp: "2026-10-29T12:00:00.000Z", payload: { provider: fallbackUsed ? "fallback-rules" : "openai", fallbackUsed } });
  assert.equal(say("AI_CASE_EXPLANATION_GENERATED", ai(true)).summary, "An explanation was written from the evidence rules; it changes nothing on the case");
  assert.equal(say("AI_CASE_EXPLANATION_GENERATED", ai(false)).summary, "An AI explanation was generated to read; it changes nothing on the case");
});

test("an unknown event gets a label and no sentence; a missing payload never throws", () => {
  assert.deepEqual(say("CASE_SOMETHING_NEW", { anything: 1 }), { label: "Something New", summary: null });
  assert.deepEqual(say("CASE_ESCALATED", null), { label: "Escalated", summary: null });
  // Only a LEADING prefix comes off: removing "RUN_" anywhere made this "Reverified".
  assert.equal(fallbackCaseEventLabel("CASE_RERUN_VERIFIED"), "Rerun Verified");
  assert.equal(fallbackCaseEventLabel("CASE_RERUN_FAILED"), "Rerun Failed");
});
