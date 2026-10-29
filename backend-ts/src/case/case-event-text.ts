/**
 * The words a person reads for one case event: a short label and a sentence, built from the payload its
 * writer recorded (#865).
 *
 * The case page printed every event's payload as JSON, to every role, under a label made by deleting
 * prefixes from the event type, which turned CASE_RERUN_VERIFIED into "Reverified". The patient page's
 * Recent Activity kept its own short list that missed outreach entirely: it looked for `OUTREACH_SENT`,
 * and the ledger writes `CASE_OUTREACH_SENT`. One description now serves both.
 *
 * It states only what the payload states. A field the writer did not record is left out of the sentence,
 * never filled in, and an event this file does not know gets a label and no sentence rather than a guess.
 * The actor is not in the sentence: each surface shows who did it in its own place.
 */
import { DEPLOYMENT_PROFILE } from "../config/deployment-profile.ts";

export interface CaseEventText {
  label: string;
  /** A sentence about what happened, or null where the payload says nothing a person needs. */
  summary: string | null;
}

export interface DescribableCaseEvent {
  eventType: string;
  payload: Record<string, unknown> | null | undefined;
}

/** A non-empty string, or null. Payloads are JSON from the ledger, so nothing is trusted to be a string. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** An assignee as a person reads it: the writers record "unassigned" for nobody, and an old row may hold null. */
function person(value: unknown): string | null {
  const s = text(value);
  return s && s.toLowerCase() !== "unassigned" ? s : null;
}

/** OVERDUE -> "overdue", DUE_SOON -> "due soon": a status inside a sentence. */
function status(value: unknown): string | null {
  const s = text(value);
  return s ? s.toLowerCase().replace(/_/g, " ") : null;
}

/** HIGH -> "High": a status that starts its own phrase. */
function titled(value: unknown): string | null {
  const s = status(value);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/**
 * A scheduled time in the practice's zone, naming the zone, because the server has no browser to ask.
 * An unparseable value is left out rather than printed raw.
 */
function when(value: unknown, timeZone: string | null): string | null {
  const s = text(value);
  if (!s) return null;
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) return null;
  // Spelled out field by field: `dateStyle` cannot be combined with `timeZoneName`.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/**
 * The label for an event this file does not know. Only a LEADING prefix comes off: the old frontend
 * removed "RUN_" anywhere in the string, which is how CASE_RERUN_VERIFIED read "Reverified".
 */
export function fallbackCaseEventLabel(eventType: string): string {
  return eventType
    .replace(/^(CASE_ACTION_|CASE_|OUTCOME_|RUN_)/, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function assigned(p: Record<string, unknown>): string {
  const to = person(p.assignee);
  // Say what it was only where the writer recorded it: every current writer does, an old row may not.
  const was = "previousAssignee" in p ? ` (was ${person(p.previousAssignee) ?? "unassigned"})` : "";
  const how = text(p.panel) ? ", from the provider's panel" : p.bulk === true ? ", in a bulk assignment" : "";
  return to ? `Assigned to ${to}${was}${how}` : `Unassigned${was}${how}`;
}

function resolved(p: Record<string, unknown>): string {
  if (p.reason === "CYCLE_ROLLED_OVER") {
    const prior = text(p.priorPeriod);
    const current = text(p.currentPeriod);
    return prior && current
      ? `Closed: a new measurement period began (${prior} to ${current})`
      : "Closed: a new measurement period began";
  }
  if (p.closedReason === "OUT_OF_POPULATION") return "Closed: no longer in this measure's population";
  // A run's closure records its disposition; a rerun-to-verify's does not.
  if ("disposition" in p) return "Closed: the latest run found the measure met";
  return "Closed: a re-check found the measure met";
}

function outreach(p: Record<string, unknown>): string | null {
  // The audit row nests the action's detail under `action`; read the top level too, for older rows.
  const a = (typeof p.action === "object" && p.action !== null ? p.action : p) as Record<string, unknown>;
  const template = text(a.templateName) ?? text(a.template);
  const channel = status(a.channel);
  const delivery = status(a.deliveryStatus);
  const head = template ? `${template} sent` : "Sent";
  const parts = [head + (channel ? ` by ${channel}` : ""), delivery ? `delivery ${delivery}` : null];
  const sentence = parts.filter(Boolean).join(", ");
  return a.autoTriggered === true ? `${sentence} (automatic)` : sentence;
}

/** The label and sentence for one case event (pure; the practice zone is a parameter for tests). */
export function describeCaseEvent(
  event: DescribableCaseEvent,
  timeZone: string | null = DEPLOYMENT_PROFILE.practiceTimeZone,
): CaseEventText {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.eventType) {
    case "CASE_CREATED": {
      const s = status(p.outcomeStatus);
      const to = person(p.assignee);
      const placed = to ? `, assigned to ${to}${p.assignmentSource === "PANEL" ? " from the provider's panel" : ""}` : "";
      return { label: "Created", summary: s ? `Opened as ${s}${placed}` : to ? `Opened${placed}` : null };
    }
    case "CASE_UPDATED": {
      const s = status(p.outcomeStatus);
      // The run writes a reopen as CASE_UPDATED and says which in the payload (`CASE_EVENT_FOR`).
      if (p.disposition === "REOPENED") return { label: "Reopened", summary: s ? `Reopened: the latest run found it ${s}` : "Reopened by the latest run" };
      return { label: "Updated", summary: s ? `The latest run found it ${s}` : null };
    }
    case "CASE_RESOLVED":
      return { label: "Resolved", summary: resolved(p) };
    case "CASE_EXCLUDED":
      return { label: "Excluded", summary: text(p.exclusionReason) ?? "Closed as excluded" };
    case "CASE_ASSIGNED":
      return { label: "Assigned", summary: assigned(p) };
    case "CASE_ESCALATED": {
      const priority = titled(p.priority);
      return { label: "Escalated", summary: priority ? `Priority raised to ${priority}` : null };
    }
    case "CASE_MANUALLY_CLOSED": {
      const note = text(p.note);
      return { label: "Closed", summary: note ? `Closed with the note: ${note}` : "Closed by staff" };
    }
    case "CASE_OUTREACH_SENT":
      return { label: "Outreach Sent", summary: outreach(p) };
    case "CASE_OUTREACH_DELIVERY_UPDATED": {
      const delivery = status(p.deliveryStatus);
      return { label: "Delivery Updated", summary: delivery ? `Delivery ${delivery}` : null };
    }
    case "CASE_RERUN_VERIFIED": {
      const was = status(p.priorOutcomeStatus);
      const now = status(p.verifiedStatus);
      const summary = was && now ? `Re-checked: was ${was}, now ${now}` : now ? `Re-checked: now ${now}` : null;
      return { label: "Re-checked", summary };
    }
    case "CASE_RERUN_FAILED":
      return { label: "Re-check Failed", summary: "The re-check could not evaluate the record; the case was left unchanged" };
    case "APPOINTMENT_SCHEDULED": {
      const type = text(p.appointmentType);
      const at = when(p.scheduledAt, timeZone);
      const where = text(p.location);
      // The writer records no notes as "": staff typed these, and the timeline is no longer JSON to them.
      const notes = text(p.notes);
      const summary = [type ? `${type} scheduled` : "Scheduled", at ? `for ${at}` : null, where ? `at ${where}` : null]
        .filter(Boolean)
        .join(" ");
      return { label: "Appointment Scheduled", summary: notes ? `${summary}, with the note: ${notes}` : summary };
    }
    case "EVIDENCE_UPLOADED": {
      const file = text(p.fileName);
      const description = text(p.description);
      return { label: "Evidence Uploaded", summary: file ? `Uploaded ${file}${description ? `: ${description}` : ""}` : null };
    }
    case "EVIDENCE_DOWNLOADED": {
      const file = text(p.fileName);
      return { label: "Evidence Downloaded", summary: file ? `Downloaded ${file}` : null };
    }
    case "AI_CASE_EXPLANATION_GENERATED": {
      // Assistive text only (AI_GUARDRAILS §1): the sentence says it changed nothing, because it did not.
      // `insertAiAudit` (ai/ai-assist.ts) nests the surface's fields one level down, `{ timestamp, payload }`.
      // Reading `fallbackUsed` at the top called every rules-written explanation an AI one.
      const surface = typeof p.payload === "object" && p.payload !== null ? (p.payload as Record<string, unknown>) : p;
      return {
        label: "AI Explanation",
        summary:
          surface.fallbackUsed === true
            ? "An explanation was written from the evidence rules; it changes nothing on the case"
            : "An AI explanation was generated to read; it changes nothing on the case",
      };
    }
    case "CASE_SLA_BREACHED":
      // No longer written (#600); older ledgers still hold it.
      return { label: "SLA Breached", summary: "Priority escalated after the SLA was breached" };
    default:
      return { label: fallbackCaseEventLabel(event.eventType), summary: null };
  }
}
