/**
 * Campaign engine (#75 E5) — resolve eligible OPEN cases (measure/site/outcome), then dispatch
 * outreach per recipient via the channel (simulated by default) reusing dispatchOutreach, and persist
 * the result via the CampaignStore. dryRun previews recipients with no sends, no audit, no persistence.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CampaignStore, CampaignRecord, CampaignRecipientRecord } from "../stores/campaign-store.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { dispatchOutreach, type OutreachDeps } from "./case-outreach.ts";
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
  recipients: CampaignRecipientRecord[];
}

export class CampaignError extends Error {}

const eq = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

export async function runCampaign(deps: CampaignDeps, req: CampaignRequest, actor: string): Promise<CampaignResult> {
  if (!isChannelType(req.channel)) throw new CampaignError("channel must be EMAIL, SMS, or PHONE");
  const measureId = req.measureId?.trim() || undefined;
  const site = req.site?.trim() || null;
  const outcome = req.outcomeStatus?.trim() || null;

  const open = await deps.cases.listCases({ statuses: ["OPEN"], measureId, limit: 100000 });
  const eligible = open.filter(
    (c) => (!site || eq(employeeById(c.employeeId)?.site ?? null, site)) && (!outcome || eq(c.currentOutcomeStatus, outcome)),
  );

  if (req.dryRun) {
    const recipients: CampaignRecipientRecord[] = eligible.map((c) => ({
      campaignId: "", caseId: c.id, employeeId: c.employeeId, employeeName: employeeById(c.employeeId)?.name ?? c.employeeId,
      channel: req.channel, toAddress: req.channel === "EMAIL" ? `${c.employeeId}@workwell-demo.dev` : req.channel === "SMS" ? `sms:${c.employeeId}` : `tel:${c.employeeId}`,
      status: "PREVIEW", messageId: null, sentAt: "",
    }));
    return { campaignId: null, channel: req.channel, dryRun: true, total: recipients.length, sent: 0, failed: 0, simulated: 0, recipients };
  }

  const campaignId = crypto.randomUUID();
  const outreachDeps: OutreachDeps = { cases: deps.cases, events: deps.events, outcomes: deps.outcomes, channels: deps.channels };
  const recipients: CampaignRecipientRecord[] = [];
  let sent = 0, failed = 0, simulated = 0;
  for (const c of eligible) {
    const d = await dispatchOutreach(outreachDeps, c, { channel: req.channel, templateId: req.templateId, campaignId, actor });
    if (d.status === "FAILED") failed++; else sent++;
    if (d.status === "SIMULATED") simulated++;
    recipients.push({
      campaignId, caseId: d.caseId, employeeId: d.employeeId, employeeName: employeeById(d.employeeId)?.name ?? d.employeeId,
      channel: d.channel, toAddress: d.toAddress, status: d.status, messageId: d.messageId, sentAt: new Date().toISOString(),
    });
  }
  const campaign: CampaignRecord = {
    id: campaignId, channel: req.channel, measureId: measureId ?? null, site, outcomeStatus: outcome,
    templateId: req.templateId ?? null, status: failed > 0 ? "PARTIAL_FAILURE" : "COMPLETED",
    total: recipients.length, sent, failed, simulated, createdBy: actor, createdAt: new Date().toISOString(),
  };
  await deps.campaigns.recordCampaign(campaign, recipients);
  return { campaignId, channel: req.channel, dryRun: false, total: recipients.length, sent, failed, simulated, recipients };
}

export async function listCampaigns(deps: CampaignDeps): Promise<CampaignRecord[]> {
  return deps.campaigns.listCampaigns();
}
export async function getCampaignDetail(deps: CampaignDeps, id: string): Promise<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } | null> {
  const campaign = await deps.campaigns.getCampaign(id);
  if (!campaign) return null;
  return { campaign, recipients: await deps.campaigns.listRecipients(id) };
}
