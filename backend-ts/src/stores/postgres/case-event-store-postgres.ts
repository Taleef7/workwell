/**
 * Postgres-ceiling implementation of the CaseEventStore contract (#107 cases actions).
 * Same contract as the SQLite floor; payloads live in native JSONB columns and the
 * timeline UNION orders by occurred_at then the IDENTITY id. Schema-qualified to the
 * isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type {
  AppendAuditInput,
  CaseEventStore,
  InsertActionInput,
  TimelineEntry,
} from "../case-event-store.ts";

interface TimelineRow {
  event_type: string;
  actor: string | null;
  occurred_at: Date | string;
  payload_json: unknown;
  timeline_source: string;
}

export class PgCaseEventStore implements CaseEventStore {
  constructor(private readonly pool: PgPool) {}

  private static readonly ACTION_SQL = `INSERT INTO ${SPIKE_SCHEMA}.case_actions
      (case_id, action_type, payload_json, performed_by, performed_at) VALUES ($1, $2, $3::jsonb, $4, $5)`;
  private static readonly AUDIT_SQL = `INSERT INTO ${SPIKE_SCHEMA}.audit_events
      (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json, occurred_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`;

  private static actionParams(input: InsertActionInput): unknown[] {
    return [input.caseId, input.actionType, JSON.stringify(input.payload), input.actor, new Date().toISOString()];
  }
  private static auditParams(input: AppendAuditInput): unknown[] {
    return [
      input.eventType,
      input.entityType,
      input.entityId,
      input.actor,
      input.refRunId,
      input.refCaseId,
      input.refMeasureVersionId,
      JSON.stringify(input.payload),
      new Date().toISOString(),
    ];
  }

  async insertAction(input: InsertActionInput): Promise<void> {
    await this.pool.query(PgCaseEventStore.ACTION_SQL, PgCaseEventStore.actionParams(input));
  }

  async appendAudit(input: AppendAuditInput): Promise<void> {
    await this.pool.query(PgCaseEventStore.AUDIT_SQL, PgCaseEventStore.auditParams(input));
  }

  async recordCaseEvent(input: { action: InsertActionInput; audit: AppendAuditInput }): Promise<void> {
    // Single client + BEGIN/COMMIT so the action + audit insert commit atomically.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(PgCaseEventStore.ACTION_SQL, PgCaseEventStore.actionParams(input.action));
      await client.query(PgCaseEventStore.AUDIT_SQL, PgCaseEventStore.auditParams(input.audit));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async hasOutreachSent(caseId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${SPIKE_SCHEMA}.case_actions WHERE case_id = $1::uuid AND action_type = 'OUTREACH_SENT'`,
      [caseId],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async latestOutreachDeliveryStatus(caseId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ delivery_status: string | null }>(
      `SELECT payload_json ->> 'deliveryStatus' AS delivery_status
         FROM ${SPIKE_SCHEMA}.case_actions
        WHERE case_id = $1::uuid AND action_type IN ('OUTREACH_DELIVERY_UPDATED', 'OUTREACH_SENT')
        ORDER BY performed_at DESC, id DESC LIMIT 1`,
      [caseId],
    );
    return rows[0]?.delivery_status ?? null;
  }

  async caseTimeline(caseId: string): Promise<TimelineEntry[]> {
    // Two separate bind params (not a reused $1): audit_events.ref_case_id is TEXT while
    // case_actions.case_id is UUID, so a single placeholder forces Postgres to deduce one
    // type for both comparisons and fails at bind time. $2 carries an explicit ::uuid cast.
    const { rows } = await this.pool.query<TimelineRow>(
      `SELECT event_type, actor, occurred_at, payload_json, timeline_source FROM (
          SELECT event_type, actor, occurred_at, payload_json, 'audit_event' AS timeline_source, id AS sort_key
            FROM ${SPIKE_SCHEMA}.audit_events
           WHERE ref_case_id = $1 AND event_type <> 'CASE_VIEWED'
          UNION ALL
          SELECT action_type AS event_type, performed_by AS actor, performed_at AS occurred_at,
                 payload_json, 'case_action' AS timeline_source, id AS sort_key
            FROM ${SPIKE_SCHEMA}.case_actions
           WHERE case_id = $2::uuid
       ) t ORDER BY occurred_at ASC, sort_key ASC`,
      [caseId, caseId],
    );
    return rows.map((r) => ({
      eventType: r.event_type,
      actor: r.actor,
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
      // pg returns JSONB already parsed.
      payload: { ...((r.payload_json as Record<string, unknown>) ?? {}), timelineSource: r.timeline_source },
    }));
  }
}
