/**
 * Postgres-ceiling implementation of the CaseEventStore contract (#107 cases actions).
 * Same contract as the SQLite floor; payloads live in native JSONB columns and the
 * timeline UNION orders by occurred_at then the IDENTITY id. Schema-qualified to the
 * isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import { isUuid, type PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type {
  AppendAuditInput,
  AuditEventRow,
  CaseEventStore,
  InsertActionInput,
  PacketExportInput,
  TimelineEntry,
} from "../case-event-store.ts";

interface AuditRow {
  occurred_at: Date | string;
  event_type: string;
  actor: string | null;
  ref_run_id: string | null;
  ref_case_id: string | null;
  ref_measure_version_id: string | null;
  payload_json: unknown;
}

const toAuditEventRow = (r: AuditRow): AuditEventRow => ({
  occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
  eventType: r.event_type,
  actor: r.actor,
  refRunId: r.ref_run_id,
  refCaseId: r.ref_case_id,
  refMeasureVersionId: r.ref_measure_version_id,
  payload: (r.payload_json as Record<string, unknown>) ?? {},
});

interface TimelineRow {
  event_type: string;
  actor: string | null;
  occurred_at: Date | string;
  payload_json: unknown;
  timeline_source: string;
}

/**
 * How many case ids one `latestOutreachDeliveryStatuses` statement asks about.
 *
 * NOT the 500 the batched INSERTs use. That number is Postgres' 65,535-parameter cap divided by the
 * binds per row; this statement passes the whole set as ONE array parameter, so the cap does not apply
 * and copying 500 across would have been a bound borrowed from a different problem. What bounds this
 * instead is how long one statement may hold its connection, because the export runs beside the
 * pilot's pages.
 *
 * Measured 2026-09-13 on `postgres:16` with a 460,000-row `case_actions` and a 40,000-case export,
 * `EXPLAIN (ANALYZE, BUFFERS)` plus wall clock, in a rolled-back transaction (numbers in the journal):
 *
 * | ids/statement | plan | per statement | statements | wall |
 * |---|---|---|---|---|
 * | 5,000 | Unique > Gather Merge > Sort | 32.8 ms | 8 | 417 ms |
 * | 10,000 | same | 35.8 ms | 4 | 214 ms |
 * | 20,000 | same | 52.0 ms | 2 | 136 ms |
 *
 * Smaller chunks are strictly WORSE, which is the opposite of the intuition that sent me to 500: the
 * per-statement cost dominates, and every chunk re-plans and re-scans, so 30 chunks of 500 measured
 * 1,335 ms against 49 ms for one statement of 15,000. The plan is `Unique > Gather Merge > Sort` at
 * every size — a sort of the matched set — so the per-statement cost tracks how big `case_actions`
 * is rather than how many ids are asked for, which is why splitting the ids buys nothing and costs a
 * re-scan. Worth re-measuring if that table grows well past the 460,000 rows used here.
 * 10,000 keeps any single statement under ~40 ms
 * — a scale the pilot's pages do not notice — while the pilot's ~15,300 open cases take TWO round
 * trips instead of 15,300. At the ~40 ms round trip Neon charges, that is the difference between
 * 0.1 s and 10 minutes.
 */
export const OUTREACH_STATUS_CHUNK = 10_000;

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

  async appendAudits(inputs: AppendAuditInput[]): Promise<void> {
    if (inputs.length === 0) return;
    // Sub-chunked: 9 bind parameters per row against Postgres' 65535 cap, so 500 rows is 4,500 —
    // the same shape and the same headroom as `recordOutcomes`.
    const CHUNK = 500;
    for (let start = 0; start < inputs.length; start += CHUNK) {
      const slice = inputs.slice(start, start + CHUNK);
      const binds: unknown[] = [];
      const tuples = slice.map((input) => {
        const b = binds.length;
        binds.push(...PgCaseEventStore.auditParams(input));
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}::jsonb, $${b + 9})`;
      });
      try {
        await this.pool.query(
          `INSERT INTO ${SPIKE_SCHEMA}.audit_events
            (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json, occurred_at)
            VALUES ${tuples.join(", ")}`,
          binds,
        );
      } catch {
        // One multi-row INSERT is all-or-nothing, so a single malformed payload would otherwise cost
        // this whole sub-chunk — up to 500 ledger entries — against a hard rule that every state
        // change is audited. Fall back to a row at a time so the blast radius is the bad row, exactly
        // the "losers go through the proven path" shape the case store uses. The last row to fail
        // propagates, so the caller still hears that the ledger is incomplete.
        let lastError: unknown = null;
        for (const input of slice) {
          try {
            await this.appendAudit(input);
          } catch (err) {
            lastError = err;
          }
        }
        if (lastError) throw lastError;
      }
    }
  }

  async hasAuditEvent(input: Pick<AppendAuditInput, "eventType" | "entityId" | "refMeasureVersionId">): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM ${SPIKE_SCHEMA}.audit_events
        WHERE event_type = $1 AND entity_id IS NOT DISTINCT FROM $2 AND ref_measure_version_id IS NOT DISTINCT FROM $3
        LIMIT 1`,
      [input.eventType, input.entityId, input.refMeasureVersionId],
    );
    return rows.length > 0;
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

  async recordCaseEvents(inputs: readonly { action: InsertActionInput; audit: AppendAuditInput }[]): Promise<void> {
    if (inputs.length === 0) return;
    // One client, one BEGIN/COMMIT over the whole batch: a bulk action commits whole or not at all,
    // the same guarantee `recordCaseEvent` gives a single one.
    //
    // TWO multi-row INSERTs per sub-chunk, not two per CASE. The loop form was a round trip per row
    // per arm, which a per-case bulk assign never noticed and a panel backfill does: moving a
    // provider's 1,200 open cases meant 2,400 serialized round trips to Neon before the assignment
    // updates had even started, inside a synchronous PUT. Same rows, same order, same transaction —
    // `appendAudits` already writes the ledger this way and this is the shape it uses.
    //
    // 5 binds per action row and 9 per audit row, so 500 rows is 2,500 and 4,500 against Postgres'
    // 65,535 cap — the headroom `appendAudits` and `recordOutcomes` already assume.
    const CHUNK = 500;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (let start = 0; start < inputs.length; start += CHUNK) {
        const slice = inputs.slice(start, start + CHUNK);

        const actionBinds: unknown[] = [];
        const actionTuples = slice.map(({ action }) => {
          const b = actionBinds.length;
          actionBinds.push(...PgCaseEventStore.actionParams(action));
          return `($${b + 1}, $${b + 2}, $${b + 3}::jsonb, $${b + 4}, $${b + 5})`;
        });
        await client.query(
          `INSERT INTO ${SPIKE_SCHEMA}.case_actions
            (case_id, action_type, payload_json, performed_by, performed_at)
            VALUES ${actionTuples.join(", ")}`,
          actionBinds,
        );

        const auditBinds: unknown[] = [];
        const auditTuples = slice.map(({ audit }) => {
          const b = auditBinds.length;
          auditBinds.push(...PgCaseEventStore.auditParams(audit));
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}::jsonb, $${b + 9})`;
        });
        await client.query(
          `INSERT INTO ${SPIKE_SCHEMA}.audit_events
            (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json, occurred_at)
            VALUES ${auditTuples.join(", ")}`,
          auditBinds,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async hasOutreachSent(caseId: string): Promise<boolean> {
    if (!isUuid(caseId)) return false; // a non-uuid path param must be a clean miss, not a ::uuid 500 (Fable M14)
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${SPIKE_SCHEMA}.case_actions WHERE case_id = $1::uuid AND action_type = 'OUTREACH_SENT'`,
      [caseId],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async outreachSentCounts(caseIds: readonly string[]): Promise<Record<string, number>> {
    const ids = caseIds.filter(isUuid); // drop non-uuid ids so ANY($1::uuid[]) can't 500 (Fable M14)
    if (ids.length === 0) return {};
    const out: Record<string, number> = {};
    // Chunked on the same terms as `latestOutreachDeliveryStatuses`, and sequentially: this one is
    // asked by the work list, whose caller can hand it every open case on the deployment.
    for (let start = 0; start < ids.length; start += OUTREACH_STATUS_CHUNK) {
      const { rows } = await this.pool.query<{ case_id: string; n: string }>(
        `SELECT case_id, COUNT(*) AS n FROM ${SPIKE_SCHEMA}.case_actions
          WHERE action_type = 'OUTREACH_SENT' AND case_id = ANY($1::uuid[])
          GROUP BY case_id`,
        [ids.slice(start, start + OUTREACH_STATUS_CHUNK)],
      );
      for (const r of rows) out[r.case_id] = Number(r.n);
    }
    return out;
  }

  async latestOutreachDeliveryStatus(caseId: string): Promise<string | null> {
    if (!isUuid(caseId)) return null; // clean miss for a non-uuid path param, not a ::uuid 500 (Fable M14)
    const { rows } = await this.pool.query<{ delivery_status: string | null }>(
      `SELECT payload_json ->> 'deliveryStatus' AS delivery_status
         FROM ${SPIKE_SCHEMA}.case_actions
        WHERE case_id = $1::uuid AND action_type IN ('OUTREACH_DELIVERY_UPDATED', 'OUTREACH_SENT')
        ORDER BY performed_at DESC, id DESC LIMIT 1`,
      [caseId],
    );
    return rows[0]?.delivery_status ?? null;
  }

  async latestOutreachDeliveryStatuses(caseIds: readonly string[]): Promise<Record<string, string | null>> {
    const ids = caseIds.filter(isUuid); // drop non-uuid ids so ANY($1::uuid[]) can't 500 (Fable M14)
    if (ids.length === 0) return {};
    const out: Record<string, string | null> = {};
    // Chunks are read ONE AT A TIME. `Promise.all` over the chunks would be the same defect this
    // method exists to remove, one size up: the export's problem was never the number of rows, it was
    // holding every connection in the pool at once.
    for (let start = 0; start < ids.length; start += OUTREACH_STATUS_CHUNK) {
      const slice = ids.slice(start, start + OUTREACH_STATUS_CHUNK);
      // DISTINCT ON takes the FIRST row of each case_id under the ORDER BY, which is the same
      // `performed_at DESC, id DESC` the single-id method's LIMIT 1 takes — including when that row's
      // payload has no `deliveryStatus` and the column is NULL. An aggregate over the status column
      // (`max(...)`) would instead skip the NULL and report an older, superseded status.
      const { rows } = await this.pool.query<{ case_id: string; delivery_status: string | null }>(
        `SELECT DISTINCT ON (case_id) case_id, payload_json ->> 'deliveryStatus' AS delivery_status
           FROM ${SPIKE_SCHEMA}.case_actions
          WHERE case_id = ANY($1::uuid[]) AND action_type IN ('OUTREACH_DELIVERY_UPDATED', 'OUTREACH_SENT')
          ORDER BY case_id, performed_at DESC, id DESC`,
        [slice],
      );
      for (const r of rows) out[r.case_id] = r.delivery_status;
    }
    return out;
  }

  async listAuditEvents(limit = 100000, offset = 0): Promise<AuditEventRow[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
         FROM ${SPIKE_SCHEMA}.audit_events ORDER BY occurred_at ASC, id ASC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(toAuditEventRow);
  }

  async recentAuditEventsByType(eventType: string, limit: number): Promise<AuditEventRow[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
         FROM ${SPIKE_SCHEMA}.audit_events WHERE event_type = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [eventType, limit],
    );
    return rows.map(toAuditEventRow);
  }

  async recentAuditEvents(limit: number): Promise<AuditEventRow[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
         FROM ${SPIKE_SCHEMA}.audit_events ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toAuditEventRow);
  }

  async auditEventsForCases(caseIds: string[], limit: number): Promise<AuditEventRow[]> {
    if (caseIds.length === 0) return [];
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
         FROM ${SPIKE_SCHEMA}.audit_events WHERE ref_case_id = ANY($1) ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [caseIds, limit],
    );
    return rows.map(toAuditEventRow);
  }

  async auditEventsByRun(runId: string): Promise<AuditEventRow[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
         FROM ${SPIKE_SCHEMA}.audit_events WHERE ref_run_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [runId],
    );
    return rows.map(toAuditEventRow);
  }

  async auditEventsByMeasureVersion(measureVersionId: string): Promise<AuditEventRow[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
         FROM ${SPIKE_SCHEMA}.audit_events WHERE ref_measure_version_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [measureVersionId],
    );
    return rows.map(toAuditEventRow);
  }

  async insertPacketExport(input: PacketExportInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.audit_packet_exports
         (id, packet_type, entity_id, format, generated_by, generated_at, payload_hash, payload_size_bytes)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(),
        input.packetType,
        input.entityId,
        input.format,
        input.generatedBy,
        new Date().toISOString(),
        input.payloadHash,
        input.payloadSizeBytes,
      ],
    );
  }

  async caseTimeline(caseId: string): Promise<TimelineEntry[]> {
    // Single-source: the timeline reads ONLY audit_events. Every action also writes a twin
    // case_action (recordCaseEvent's atomic dual-write), but UNION-ing both arms double-listed
    // every assign/outreach/escalate on the case-detail timeline. audit_events is the canonical
    // ledger (CLAUDE.md: every state change writes an audit_event), so it is complete on its own.
    const { rows } = await this.pool.query<TimelineRow>(
      `SELECT event_type, actor, occurred_at, payload_json, 'audit_event' AS timeline_source
         FROM ${SPIKE_SCHEMA}.audit_events
        WHERE ref_case_id = $1 AND event_type <> 'CASE_VIEWED'
        ORDER BY occurred_at ASC, id ASC`,
      [caseId],
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
