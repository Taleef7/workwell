/**
 * SQLite/D1 floor implementation of the CaseEventStore contract (#107 cases actions).
 *
 * The timeline query mirrors the Java loadCaseTimeline UNION: audit_events (excluding
 * CASE_VIEWED) ∪ case_actions, ordered by occurred_at then the autoincrement id as a
 * stable tiebreak. payload_json round-trips as parsed JSON with a `timelineSource`
 * discriminator injected so the UI can tell ledger rows from operator actions.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type {
  AppendAuditInput,
  CaseEventStore,
  InsertActionInput,
  TimelineEntry,
} from "../case-event-store.ts";

interface TimelineRow {
  event_type: string;
  actor: string | null;
  occurred_at: string;
  payload_json: string | null;
  timeline_source: string;
}

export class SqliteCaseEventStore implements CaseEventStore {
  constructor(private readonly db: CloudDatabase) {}

  // Both inserts end with `RETURNING id`: harmless for `.run()` (insertAction/appendAudit),
  // and required for the atomic `batch()` path — the cloud-local D1 adapter executes batched
  // statements via `.all()`, which throws on a non-returning statement.
  private actionStmt(input: InsertActionInput) {
    return this.db
      .prepare(
        "INSERT INTO case_actions (case_id, action_type, payload_json, performed_by, performed_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(input.caseId, input.actionType, JSON.stringify(input.payload), input.actor, new Date().toISOString());
  }

  private auditStmt(input: AppendAuditInput) {
    return this.db
      .prepare(
        `INSERT INTO audit_events
           (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(
        input.eventType,
        input.entityType,
        input.entityId,
        input.actor,
        input.refRunId,
        input.refCaseId,
        input.refMeasureVersionId,
        JSON.stringify(input.payload),
        new Date().toISOString(),
      );
  }

  async insertAction(input: InsertActionInput): Promise<void> {
    await this.actionStmt(input).run();
  }

  async appendAudit(input: AppendAuditInput): Promise<void> {
    await this.auditStmt(input).run();
  }

  async recordCaseEvent(input: { action: InsertActionInput; audit: AppendAuditInput }): Promise<void> {
    // D1 runs a batch atomically (single transaction) — action + audit commit together or not at all.
    await this.db.batch([this.actionStmt(input.action), this.auditStmt(input.audit)]);
  }

  async hasOutreachSent(caseId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM case_actions WHERE case_id = ? AND action_type = 'OUTREACH_SENT'")
      .bind(caseId)
      .first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  }

  async latestOutreachDeliveryStatus(caseId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.deliveryStatus') AS delivery_status
           FROM case_actions
          WHERE case_id = ? AND action_type IN ('OUTREACH_DELIVERY_UPDATED', 'OUTREACH_SENT')
          ORDER BY performed_at DESC, id DESC LIMIT 1`,
      )
      .bind(caseId)
      .first<{ delivery_status: string | null }>();
    return row?.delivery_status ?? null;
  }

  async caseTimeline(caseId: string): Promise<TimelineEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT event_type, actor, occurred_at, payload_json, timeline_source FROM (
            SELECT event_type, actor, occurred_at, payload_json, 'audit_event' AS timeline_source, id AS sort_key
              FROM audit_events
             WHERE ref_case_id = ? AND event_type <> 'CASE_VIEWED'
            UNION ALL
            SELECT action_type AS event_type, performed_by AS actor, performed_at AS occurred_at,
                   payload_json, 'case_action' AS timeline_source, id AS sort_key
              FROM case_actions
             WHERE case_id = ?
         ) ORDER BY occurred_at ASC, sort_key ASC`,
      )
      .bind(caseId, caseId)
      .all<TimelineRow>();
    return (results ?? []).map((r) => ({
      eventType: r.event_type,
      actor: r.actor,
      occurredAt: r.occurred_at,
      payload: { ...(r.payload_json ? JSON.parse(r.payload_json) : {}), timelineSource: r.timeline_source },
    }));
  }
}
