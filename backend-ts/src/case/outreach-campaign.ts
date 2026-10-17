/**
 * Campaign engine (#75 E5) — resolve eligible OPEN cases (measure/site/outcome), then dispatch
 * outreach per recipient via the channel (simulated by default) reusing dispatchOutreach, and persist
 * the result via the CampaignStore. dryRun previews recipients with no sends, no audit, no persistence.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CampaignStore, CampaignRecord, CampaignRecipientRecord } from "../stores/campaign-store.ts";
import { DEPLOYMENT_PROFILE, employeeById } from "../config/deployment-profile.ts";
import { dispatchOutreach, dispatchPatientOutreach, type DispatchResult, type OutreachDeps } from "./case-outreach.ts";
import { isSensitiveMeasure } from "./care-item.ts";
import { isChannelType, type ChannelType, type OutreachChannel } from "./outreach-channel.ts";

export interface CampaignDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
  campaigns: CampaignStore;
  channels?: (type: ChannelType) => OutreachChannel; // default: all simulated (resolveChannel(type,{}))
}

export interface CampaignRequest {
  measureId?: string | null;
  site?: string | null;
  outcomeStatus?: string | null;
  channel: ChannelType;
  templateId?: string | null;
  dryRun?: boolean;
}

export interface CampaignResult {
  campaignId: string | null;
  channel: ChannelType;
  dryRun: boolean;
  total: number; sent: number; failed: number; simulated: number;
  /** Messages sent (or that a dry run would send): one per patient on a patient deployment, one per case otherwise. */
  messages: number;
  /** Open cases left out because their measure is never sent automatically (CMS2, CMS137 on a patient deployment). */
  withheld: number;
  recipients: CampaignRecipientRecord[];
}

export class CampaignError extends Error {}

const eq = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/** Channel-appropriate synthetic to-address for a recipient (shared by dryRun preview + failure path). */
const toAddressFor = (channel: ChannelType, employeeId: string): string =>
  channel === "EMAIL" ? `${employeeId}@workwell-demo.dev` : channel === "SMS" ? `sms:${employeeId}` : `tel:${employeeId}`;

export async function runCampaign(deps: CampaignDeps, req: CampaignRequest, actor: string): Promise<CampaignResult> {
  if (!isChannelType(req.channel)) throw new CampaignError("channel must be EMAIL, SMS, or PHONE");
  const measureId = req.measureId?.trim() || undefined;
  const site = req.site?.trim() || null;
  const outcome = req.outcomeStatus?.trim() || null;

  // On a patient deployment, CMS2 (depression) and CMS137 (substance use) are never sent automatically: a
  // message about either can disclose a condition, so contacting those patients is a staff decision, case by
  // case (Q1). A campaign aimed at one is refused; a campaign over every measure leaves them out, counted.
  const patientDeployment = DEPLOYMENT_PROFILE.subjectTerm === "patient";
  if (patientDeployment && measureId && isSensitiveMeasure(measureId)) {
    throw new CampaignError("Campaigns never send for this measure; contact these patients from their case, one at a time");
  }

  const open = await deps.cases.listCases({ statuses: ["OPEN"], measureId, limit: 100000 });
  const matching = open.filter(
    (c) => (!site || eq(employeeById(c.employeeId)?.site ?? null, site)) && (!outcome || eq(c.currentOutcomeStatus, outcome)),
  );
  const eligible = patientDeployment ? matching.filter((c) => !isSensitiveMeasure(c.measureId)) : matching;
  const withheld = matching.length - eligible.length;
  // One message per patient on a patient deployment (every open gap in one message); one per case otherwise.
  const batches = patientDeployment ? groupByPatient(eligible) : eligible.map((c) => [c]);

  if (req.dryRun) {
    const recipients: CampaignRecipientRecord[] = eligible.map((c) => ({
      campaignId: "", caseId: c.id, employeeId: c.employeeId, employeeName: employeeById(c.employeeId)?.name ?? c.employeeId,
      channel: req.channel, toAddress: toAddressFor(req.channel, c.employeeId),
      status: "PREVIEW", messageId: null, sentAt: "",
    }));
    return { campaignId: null, channel: req.channel, dryRun: true, total: recipients.length, sent: 0, failed: 0, simulated: 0, messages: batches.length, withheld, recipients };
  }

  const campaignId = crypto.randomUUID();
  const outreachDeps: OutreachDeps = { cases: deps.cases, events: deps.events, outcomes: deps.outcomes, channels: deps.channels };
  const recipients: CampaignRecipientRecord[] = [];
  let sent = 0, failed = 0, simulated = 0;
  for (const batch of batches) {
    try {
      // A campaign blasts ONE template (req.templateId) to every recipient — intentionally NOT the
      // outcome-aware per-case default that the single-case send uses (resolveTemplate falls back to
      // that only when templateId is null/unknown).
      const opts = { channel: req.channel, templateId: req.templateId, campaignId, actor };
      const dispatched: DispatchResult[] = patientDeployment
        ? await dispatchPatientOutreach(outreachDeps, batch, opts)
        : [await dispatchOutreach(outreachDeps, batch[0]!, opts)];
      for (const d of dispatched) {
        if (d.status === "FAILED") failed++; else sent++;
        if (d.status === "SIMULATED") simulated++;
        recipients.push({
          campaignId, caseId: d.caseId, employeeId: d.employeeId, employeeName: employeeById(d.employeeId)?.name ?? d.employeeId,
          channel: d.channel, toAddress: d.toAddress, status: d.status, messageId: d.messageId, sentAt: new Date().toISOString(),
        });
      }
    } catch {
      // A dispatch throw must never abandon the campaign: record this batch's recipients FAILED and
      // continue so the loop always completes and recordCampaign is always reached (makes the
      // PARTIAL_FAILURE status reachable). The patient path throws only before its message is sent; a case
      // whose record fails after the send comes back as its own FAILED result, carrying the message id.
      for (const c of batch) {
        failed++;
        recipients.push({
          campaignId, caseId: c.id, employeeId: c.employeeId, employeeName: employeeById(c.employeeId)?.name ?? c.employeeId,
          channel: req.channel, toAddress: toAddressFor(req.channel, c.employeeId), status: "FAILED", messageId: null, sentAt: new Date().toISOString(),
        });
      }
    }
  }
  const campaign: CampaignRecord = {
    id: campaignId, channel: req.channel, measureId: measureId ?? null, site, outcomeStatus: outcome,
    templateId: req.templateId ?? null, status: failed > 0 ? "PARTIAL_FAILURE" : "COMPLETED",
    total: recipients.length, sent, failed, simulated, createdBy: actor, createdAt: new Date().toISOString(),
  };
  await deps.campaigns.recordCampaign(campaign, recipients);
  return { campaignId, channel: req.channel, dryRun: false, total: recipients.length, sent, failed, simulated, messages: batches.length, withheld, recipients };
}

/** Cases grouped by patient, in first-seen order, so each patient gets one message. */
function groupByPatient<T extends { employeeId: string }>(cases: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const c of cases) {
    const group = groups.get(c.employeeId);
    if (group) group.push(c);
    else groups.set(c.employeeId, [c]);
  }
  return [...groups.values()];
}

export async function listCampaigns(deps: CampaignDeps): Promise<CampaignRecord[]> {
  return deps.campaigns.listCampaigns();
}
export async function getCampaignDetail(deps: CampaignDeps, id: string): Promise<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } | null> {
  return deps.campaigns.getCampaignWithRecipients(id); // single ledger scan (vs getCampaign + listRecipients = two)
}
