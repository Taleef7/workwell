/**
 * One message about several of one patient's gaps, sent from the patient page (#868): a staff member
 * picks the gaps, previews the message, and sends it. The send is campaigns' rule for one patient: on a
 * patient deployment ONE message (`dispatchPatientOutreach`, the care items joined), otherwise one per
 * case (`dispatchOutreach`), because the occupational wording names each requirement on its own.
 *
 * CMS2 and CMS137 are not refused here, as a campaign refuses them: a person choosing them on one
 * patient's page is the case-by-case decision Q1 asks for, and the message names them only as "a visit
 * with your care team" (`care-item.ts`). The page leaves them unticked until someone ticks them.
 *
 * Audit order is the outreach paths' documented exception (DATA_MODEL_CONTRACTS §4): the message is sent,
 * then each case's action and audit are written, then the case is patched.
 */
import type { CaseRecord } from "../stores/case-store.ts";
import { ACTIVE_CASE_STATUSES } from "./case-logic.ts";
import { DEPLOYMENT_PROFILE } from "../config/deployment-profile.ts";
import {
  dispatchOutreach,
  dispatchPatientOutreach,
  previewOutreach,
  previewPatientOutreach,
  type DispatchOptions,
  type DispatchResult,
  type OutreachDeps,
} from "./case-outreach.ts";

/** A patient has one gap per routed measure and cycle; more than this is not one patient's page. */
export const PATIENT_OUTREACH_MAX_CASES = 20;

export class PatientOutreachError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly caseId?: string,
  ) {
    super(message);
  }
}

/** One message as the patient would read it, and the gaps it is about. */
export interface PatientOutreachMessage {
  caseIds: string[];
  templateId: string | null;
  templateName: string;
  subject: string;
  bodyText: string;
}

export interface PatientOutreachResult {
  /** How many messages are known to have gone out: one on a patient deployment, one per sent case otherwise. */
  messages: number;
  results: DispatchResult[];
  /** Cases whose message went out but whose record of it failed: the page must say so. */
  unrecorded: string[];
  /**
   * Cases whose own send threw (one message per case only): the throw may have come before the message or
   * after it, so the page says it may have gone out rather than that it did or did not.
   */
  failed: string[];
}

const isPatientDeployment = (): boolean => DEPLOYMENT_PROFILE.subjectTerm === "patient";

/**
 * The cases one message is about, in the order asked, or why they cannot share one: an unknown case (404),
 * cases of more than one patient (400), or a gap no longer open (409, a page older than the case).
 */
export async function loadPatientOutreachCases(
  deps: Pick<OutreachDeps, "cases">,
  caseIds: readonly string[],
): Promise<CaseRecord[]> {
  const found = new Map((await deps.cases.getCases(caseIds)).map((c) => [c.id, c]));
  const missing = caseIds.find((id) => !found.has(id));
  if (missing !== undefined) throw new PatientOutreachError(404, "not_found", `Case ${missing} was not found.`, missing);
  const cases = caseIds.map((id) => found.get(id)!);
  if (new Set(cases.map((c) => c.employeeId)).size > 1) {
    throw new PatientOutreachError(400, "mixed_subjects", "One message is about one patient, and these cases belong to more than one.");
  }
  const closed = cases.find((c) => !(ACTIVE_CASE_STATUSES as readonly string[]).includes((c.status ?? "").toUpperCase()));
  if (closed) {
    throw new PatientOutreachError(409, "case_not_active", `A chosen gap is no longer open (${closed.status}). Reload the page.`, closed.id);
  }
  return cases;
}

/** What `sendPatientOutreachMessages` would send for these cases; nothing is written. */
export async function previewPatientOutreachMessages(
  deps: OutreachDeps,
  cases: readonly CaseRecord[],
  templateId: string | null,
): Promise<PatientOutreachMessage[]> {
  if (isPatientDeployment()) {
    const p = await previewPatientOutreach(deps, cases, templateId);
    return [{ caseIds: cases.map((c) => c.id), templateId: p.templateId, templateName: p.templateName, subject: p.subject, bodyText: p.bodyText }];
  }
  const messages: PatientOutreachMessage[] = [];
  for (const c of cases) {
    const p = await previewOutreach(deps, c.id, templateId);
    if (p) messages.push({ caseIds: [c.id], templateId: p.templateId, templateName: p.templateName, subject: p.subject, bodyText: p.bodyText });
  }
  return messages;
}

export async function sendPatientOutreachMessages(
  deps: OutreachDeps,
  cases: readonly CaseRecord[],
  opts: DispatchOptions,
): Promise<PatientOutreachResult> {
  let results: DispatchResult[];
  const failed: string[] = [];
  if (isPatientDeployment()) {
    // Throws only before its message is sent; after it, a case whose record failed comes back unrecorded.
    results = await dispatchPatientOutreach(deps, cases, opts);
  } else {
    // One message per case, in turn. A case that throws is reported and the rest are still sent, as a
    // campaign does: its message may have gone out before its record failed, so it is never retried here.
    results = [];
    for (const c of cases) {
      try {
        results.push(await dispatchOutreach(deps, c, opts));
      } catch {
        failed.push(c.id);
        results.push({
          caseId: c.id, employeeId: c.employeeId, channel: opts.channel ?? "EMAIL", toAddress: "",
          status: "FAILED", messageId: "", templateName: "", recorded: false,
        });
      }
    }
  }
  return {
    messages: isPatientDeployment() ? 1 : cases.length - failed.length,
    results,
    unrecorded: results.filter((r) => !r.recorded && !failed.includes(r.caseId)).map((r) => r.caseId),
    failed,
  };
}
