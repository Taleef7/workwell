/**
 * Log a contact (#886, E27): staff record that they reached out — a call, a text, a letter, a word in the
 * clinic — without WorkWell sending anything. The case moves from OPEN to IN_PROGRESS, as scheduling an
 * appointment does; nothing about compliance changes (no outcome, `current_outcome_status` or
 * `next_action`): the gap closes only when CQL finds the result.
 *
 * One call may cover several of one subject's active cases (the patient's other open gaps). Each case is
 * written on its own, audit first (`recordCaseEvent`, action and audit in one transaction), then patched; a
 * case whose write fails is reported and the rest still go through, as `dispatchPatientOutreach` does.
 *
 * Logging on a channel the subject declined is allowed: they may have called in. The page warns.
 */
import type { CaseStore, CaseRecord } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { ACTIVE_CASE_STATUSES } from "./case-logic.ts";
import { PATIENT_OUTREACH_MAX_CASES } from "./patient-outreach.ts";

export const CONTACT_LOG_CHANNELS = ["PHONE", "SMS", "EMAIL", "IN_PERSON", "LETTER"] as const;
export type ContactLogChannel = (typeof CONTACT_LOG_CHANNELS)[number];
export const CONTACT_LOG_RESULTS = ["REACHED", "NO_ANSWER", "LEFT_MESSAGE", "WRONG_NUMBER", "DECLINED"] as const;
export type ContactLogResult = (typeof CONTACT_LOG_RESULTS)[number];
export const CONTACT_NOTE_MAX = 500;
export const CONTACT_LOG_MAX_CASES = PATIENT_OUTREACH_MAX_CASES;

export const isContactLogChannel = (v: unknown): v is ContactLogChannel =>
  typeof v === "string" && (CONTACT_LOG_CHANNELS as readonly string[]).includes(v);
export const isContactLogResult = (v: unknown): v is ContactLogResult =>
  typeof v === "string" && (CONTACT_LOG_RESULTS as readonly string[]).includes(v);

export class ContactLogError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly caseId?: string,
  ) {
    super(message);
  }
}

export interface ContactLogDeps {
  cases: CaseStore;
  events: CaseEventStore;
}

export interface ContactLogInput {
  caseIds: readonly string[];
  channel: ContactLogChannel;
  result: ContactLogResult;
  note: string | null;
  actor: string;
}

export interface ContactLogOutcome {
  /** Cases whose contact was recorded, with the status they now have. */
  logged: { caseId: string; status: string }[];
  /** Cases whose record failed: the page must say so. */
  failed: string[];
}

/** The cases, in the order asked, or why they cannot be logged together: nothing is written on a refusal. */
export async function loadContactLogCases(deps: Pick<ContactLogDeps, "cases">, caseIds: readonly string[]): Promise<CaseRecord[]> {
  const found = new Map((await deps.cases.getCases(caseIds)).map((c) => [c.id, c]));
  const missing = caseIds.find((id) => !found.has(id));
  if (missing !== undefined) throw new ContactLogError(404, "not_found", `Case ${missing} was not found.`, missing);
  const cases = caseIds.map((id) => found.get(id)!);
  if (new Set(cases.map((c) => c.employeeId)).size > 1) {
    throw new ContactLogError(400, "mixed_subjects", "One contact is with one person, and these cases belong to more than one.");
  }
  const closed = cases.find((c) => !(ACTIVE_CASE_STATUSES as readonly string[]).includes((c.status ?? "").toUpperCase()));
  if (closed) {
    throw new ContactLogError(409, "case_not_active", `A chosen gap is no longer open (${closed.status}). Reload the page.`, closed.id);
  }
  return cases;
}

export async function logContact(deps: ContactLogDeps, input: ContactLogInput): Promise<ContactLogOutcome> {
  const cases = await loadContactLogCases(deps, input.caseIds);
  const note = input.note && input.note.trim() !== "" ? input.note.trim() : null;
  if (note !== null && note.length > CONTACT_NOTE_MAX) {
    throw new ContactLogError(400, "invalid_request", `note is at most ${CONTACT_NOTE_MAX} characters`);
  }
  const out: ContactLogOutcome = { logged: [], failed: [] };
  for (const c of cases) {
    const fromStatus = (c.status ?? "").toUpperCase();
    const toStatus = fromStatus === "OPEN" ? "IN_PROGRESS" : fromStatus;
    const payload = { channel: input.channel, result: input.result, note: note ?? "", fromStatus, toStatus };
    try {
      // AUDIT BEFORE MUTATE: the action and its audit (one transaction) precede the status patch.
      await deps.events.recordCaseEvent({
        action: { caseId: c.id, actionType: "CONTACT_LOGGED", actor: input.actor, payload: { type: "CONTACT_LOGGED", ...payload } },
        audit: {
          eventType: "CASE_CONTACT_LOGGED",
          entityType: "case",
          entityId: c.id,
          actor: input.actor,
          refRunId: c.lastRunId,
          refCaseId: c.id,
          refMeasureVersionId: c.measureId,
          payload,
        },
      });
      await deps.cases.patchCase(c.id, fromStatus === "OPEN" ? { status: "IN_PROGRESS" } : {});
      out.logged.push({ caseId: c.id, status: toStatus });
    } catch {
      out.failed.push(c.id);
    }
  }
  return out;
}
