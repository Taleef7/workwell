/**
 * Audit-backed CampaignStore (#75 E5) — the demo persistence adapter. A campaign is stored as a single
 * OUTREACH_CAMPAIGN_COMPLETED audit event whose payload carries the campaign + its recipients. Reads use
 * a NEWEST-first, event-type-filtered, bounded query (recentAuditEventsByType) so a list/get only ever
 * touches campaign events — O(campaigns up to the cap), not O(total-ledger-size), and with no oldest-first
 * truncation cliff (the old listAuditEvents path is oldest-first capped at 100k across ALL event types, so
 * once the shared ledger passed 100k events the newest campaigns silently fell out of the window). No DDL on
 * floor or ceiling. Demo-scale; the production PgCampaignStore (indexed campaign queries over
 * outreach_campaigns + outreach_delivery_log) is the drop-in.
 */
import type { CaseEventStore } from "./case-event-store.ts";
import type { CampaignRecord, CampaignRecipientRecord, CampaignStore } from "./campaign-store.ts";

const CAMPAIGN_EVENT = "OUTREACH_CAMPAIGN_COMPLETED";
/** Bounded scan cap — far more campaigns than the demo will ever record, but keeps the read bounded. */
const CAMPAIGN_SCAN_CAP = 1000;

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
   * All campaign payloads, newest-first. Reads only OUTREACH_CAMPAIGN_COMPLETED events via the
   * NEWEST-first, type-filtered, bounded recentAuditEventsByType query — so it is bounded by the
   * campaign-scan cap (not the whole ledger) and has no oldest-first truncation cliff. The query is
   * already newest-first and type-filtered, so no JS event-type filter or reverse() is needed. The
   * defensive `campaign.id` filter drops malformed/foreign payloads.
   */
  private async all(): Promise<Array<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] }>> {
    const rows = await this.events.recentAuditEventsByType(CAMPAIGN_EVENT, CAMPAIGN_SCAN_CAP);
    return rows
      .map((r) => r.payload as unknown as { campaign?: CampaignRecord; recipients?: CampaignRecipientRecord[] })
      .filter((p): p is { campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } => !!p?.campaign?.id)
      .map((p) => ({ campaign: p.campaign, recipients: p.recipients ?? [] }));
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
