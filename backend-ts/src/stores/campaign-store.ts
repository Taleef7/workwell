/**
 * CampaignStore port (#75 E5) — persistence seam for outreach campaigns. The demo adapter is
 * audit-backed (no schema). The production drop-in is a PgCampaignStore over outreach_campaigns +
 * outreach_delivery_log (+ owner migration), selected on the ceiling — no consumer change.
 */
import type { ChannelType } from "../case/outreach-channel.ts";

export interface CampaignRecord {
  id: string;
  channel: ChannelType;
  measureId: string | null;
  site: string | null;
  outcomeStatus: string | null;
  templateId: string | null;
  status: string; // "COMPLETED" | "PARTIAL_FAILURE"
  total: number; sent: number; failed: number; simulated: number;
  createdBy: string;
  createdAt: string;
}

export interface CampaignRecipientRecord {
  campaignId: string;
  caseId: string;
  employeeId: string;
  employeeName: string;
  channel: ChannelType;
  toAddress: string;
  status: string;
  messageId: string | null;
  sentAt: string;
}

export interface CampaignStore {
  recordCampaign(campaign: CampaignRecord, recipients: CampaignRecipientRecord[]): Promise<void>;
  listCampaigns(limit?: number): Promise<CampaignRecord[]>; // newest-first
  getCampaign(id: string): Promise<CampaignRecord | null>;
  listRecipients(campaignId: string): Promise<CampaignRecipientRecord[]>;
  /** Campaign + its recipients in a single scan (detail view) — null if not found. */
  getCampaignWithRecipients(id: string): Promise<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } | null>;
}
