/**
 * Audit-backed CampaignStore (#75 E5) — the demo persistence adapter. A campaign is stored as a single
 * OUTREACH_CAMPAIGN_COMPLETED audit event whose payload carries the campaign + its recipients. Reads
 * scan the ENTIRE audit_events ledger (all event types, up to listAuditEvents' default cap) and filter
 * in JS on every list/get call — O(total-ledger-size), not O(campaigns). No DDL on floor or ceiling.
 * Demo-scale; the production PgCampaignStore (indexed campaign queries over outreach_campaigns +
 * outreach_delivery_log) is the drop-in.
 */
import type { CaseEventStore } from "./case-event-store.ts";
import type { CampaignRecord, CampaignRecipientRecord, CampaignStore } from "./campaign-store.ts";

const CAMPAIGN_EVENT = "OUTREACH_CAMPAIGN_COMPLETED";

export class AuditBackedCampaignStore implements CampaignStore {
  constructor(private readonly events: CaseEventStore) {}

  async recordCampaign(campaign: CampaignRecord, recipients: CampaignRecipientRecord[]): Promise<void> {
    await this.events.appendAudit({
      eventType: CAMPAIGN_EVENT, entityType: "campaign", entityId: campaign.id, actor: campaign.createdBy,
      refRunId: null, refCaseId: null, refMeasureVersionId: null,
      payload: { campaign, recipients },
    });
  }

  /**
   * All campaign payloads, newest-first (listAuditEvents is oldest-first → reverse).
   * COST: the demo adapter scans the ENTIRE audit_events ledger (all event types, up to
   * listAuditEvents' default cap) and filters in JS on every list/get call — i.e.
   * O(total-ledger-size), not O(campaigns). The production PgCampaignStore replaces this with
   * indexed campaign queries. The defensive `campaign.id` filter drops malformed/foreign payloads.
   */
  private async all(): Promise<Array<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] }>> {
    const rows = await this.events.listAuditEvents();
    return rows
      .filter((r) => r.eventType === CAMPAIGN_EVENT)
      .map((r) => r.payload as unknown as { campaign?: CampaignRecord; recipients?: CampaignRecipientRecord[] })
      .filter((p): p is { campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } => !!p?.campaign?.id)
      .map((p) => ({ campaign: p.campaign, recipients: p.recipients ?? [] }))
      .reverse();
  }

  async listCampaigns(limit = 100): Promise<CampaignRecord[]> {
    return (await this.all()).slice(0, limit).map((p) => p.campaign);
  }
  async getCampaign(id: string): Promise<CampaignRecord | null> {
    return (await this.all()).find((p) => p.campaign.id === id)?.campaign ?? null;
  }
  async listRecipients(campaignId: string): Promise<CampaignRecipientRecord[]> {
    return (await this.all()).find((p) => p.campaign.id === campaignId)?.recipients ?? [];
  }
  /** Single-scan detail: one all() pass yields both the campaign and its recipients (or null). */
  async getCampaignWithRecipients(id: string): Promise<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } | null> {
    return (await this.all()).find((p) => p.campaign.id === id) ?? null;
  }
}
