/**
 * Audit-backed CampaignStore (#75 E5) — the demo persistence adapter. A campaign is stored as a single
 * OUTREACH_CAMPAIGN_COMPLETED audit event whose payload carries the campaign + its recipients. Reads
 * scan listAuditEvents (oldest-first) and filter by eventType. No DDL on floor or ceiling. Demo-scale;
 * the production PgCampaignStore over outreach_campaigns + outreach_delivery_log is the drop-in.
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

  /** All campaign payloads, newest-first (listAuditEvents is oldest-first → reverse). */
  private async all(): Promise<Array<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] }>> {
    const rows = await this.events.listAuditEvents();
    return rows
      .filter((r) => r.eventType === CAMPAIGN_EVENT)
      .map((r) => r.payload as unknown as { campaign: CampaignRecord; recipients: CampaignRecipientRecord[] })
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
}
