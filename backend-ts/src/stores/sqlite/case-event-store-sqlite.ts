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
  AuditEventRow,
  CaseEventStore,
  InsertActionInput,
  PacketExportInput,
  TimelineEntry,
} from "../case-event-store.ts";

/**
 * Ids per statement on the floor. Here the bound IS the bind count — SQLite's compiled default
 * `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds — so this is deliberately half of it and is not
 * the ceiling's number: that one is a statement-duration choice against a one-array bind, and pinning
 * the two together would mean a measurement about Neon silently deciding what the floor may bind.
 */
export const SQLITE_ID_CHUNK = 500;

const chunked = (ids: readonly string[]): string[][] => {
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += SQLITE_ID_CHUNK) out.push(ids.slice(start, start + SQLITE_ID_CHUNK));
  return out;
};

interface AuditRow {
  occurred_at: string;
  event_type: string;
  actor: string | null;
  ref_run_id: string | null;
  ref_case_id: string | null;
  ref_measure_version_id: string | null;
  payload_json: string | null;
}

const toAuditEventRow = (r: AuditRow): AuditEventRow => ({
  occurredAt: r.occurred_at,
  eventType: r.event_type,
  actor: r.actor,
  refRunId: r.ref_run_id,
  refCaseId: r.ref_case_id,
  refMeasureVersionId: r.ref_measure_version_id,
  payload: r.payload_json ? JSON.parse(r.payload_json) : {},
});

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

  /** A loop on the floor: the batching exists to save network round trips, and SQLite has none. */
  async appendAudits(inputs: AppendAuditInput[]): Promise<void> {
    for (const input of inputs) await this.auditStmt(input).run();
  }

  async hasAuditEvent(input: Pick<AppendAuditInput, "eventType" | "entityId" | "refMeasureVersionId">): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 FROM audit_events WHERE event_type = ? AND entity_id IS ? AND ref_measure_version_id IS ? LIMIT 1",
      )
      .bind(input.eventType, input.entityId, input.refMeasureVersionId)
      .first();
    return row !== null;
  }

  async recordCaseEvent(input: { action: InsertActionInput; audit: AppendAuditInput }): Promise<void> {
    // D1 runs a batch atomically (single transaction) — action + audit commit together or not at all.
    await this.db.batch([this.actionStmt(input.action), this.auditStmt(input.audit)]);
  }

  async recordCaseEvents(inputs: readonly { action: InsertActionInput; audit: AppendAuditInput }[]): Promise<void> {
    if (inputs.length === 0) return;
    // ONE batch over every statement, so a bulk action commits whole exactly as a single one does.
    await this.db.batch(inputs.flatMap((input) => [this.actionStmt(input.action), this.auditStmt(input.audit)]));
  }

  async hasOutreachSent(caseId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM case_actions WHERE case_id = ? AND action_type = 'OUTREACH_SENT'")
      .bind(caseId)
      .first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  }

  async outreachSentCounts(caseIds: readonly string[]): Promise<Record<string, number>> {
    if (caseIds.length === 0) return {};
    const out: Record<string, number> = {};
    // Chunked (2026-09-13): this bound one placeholder per id, so a work list wide enough — the panel
    // pre-filter hands it every open case — would have hit SQLite's parameter cap and failed the whole
    // read. The ceiling never notices, because it binds the set as one array.
    for (const slice of chunked(caseIds)) {
      const placeholders = slice.map(() => "?").join(", ");
      const { results } = await this.db
        .prepare(
          `SELECT case_id, COUNT(*) AS n FROM case_actions
            WHERE action_type = 'OUTREACH_SENT' AND case_id IN (${placeholders})
            GROUP BY case_id`,
        )
        .bind(...slice)
        .all<{ case_id: string; n: number }>();
      for (const r of results ?? []) out[r.case_id] = Number(r.n);
    }
    return out;
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

  async latestOutreachDeliveryStatuses(caseIds: readonly string[]): Promise<Record<string, string | null>> {
    if (caseIds.length === 0) return {};
    const out: Record<string, string | null> = {};
    // One chunk at a time, like the ceiling: the floor has no pool to exhaust, but the two stores
    // answering the same question by different shapes is how they come to disagree.
    for (const slice of chunked(caseIds)) {
      const placeholders = slice.map(() => "?").join(", ");
      // `rn = 1` picks the same row the single-id method's `LIMIT 1` picks, under the same ordering —
      // including when that row's payload has no `deliveryStatus`, which must read as null rather than
      // falling through to an older, superseded status.
      const { results } = await this.db
        .prepare(
          `SELECT case_id, delivery_status FROM (
             SELECT case_id,
                    json_extract(payload_json, '$.deliveryStatus') AS delivery_status,
                    ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY performed_at DESC, id DESC) AS rn
               FROM case_actions
              WHERE case_id IN (${placeholders})
                AND action_type IN ('OUTREACH_DELIVERY_UPDATED', 'OUTREACH_SENT')
           ) WHERE rn = 1`,
        )
        .bind(...slice)
        .all<{ case_id: string; delivery_status: string | null }>();
      for (const r of results ?? []) out[r.case_id] = r.delivery_status;
    }
    return out;
  }

  async listAuditEvents(limit = 100000, offset = 0): Promise<AuditEventRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
           FROM audit_events ORDER BY occurred_at ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .bind(limit, offset)
      .all<AuditRow>();
    return (results ?? []).map(toAuditEventRow);
  }

  async recentAuditEventsByType(eventType: string, limit: number): Promise<AuditEventRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
           FROM audit_events WHERE event_type = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .bind(eventType, limit)
      .all<AuditRow>();
    return (results ?? []).map(toAuditEventRow);
  }

  async recentAuditEvents(limit: number): Promise<AuditEventRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
           FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .bind(limit)
      .all<AuditRow>();
    return (results ?? []).map(toAuditEventRow);
  }

  /**
   * NOT chunked, unlike its neighbours, and deliberately: the `LIMIT` is over the whole result, so
   * splitting the ids would apply it per chunk and return up to `limit x chunks` rows in the wrong
   * order. Its only caller (`run/employee-profile.ts`) passes ONE subject's case ids, so the bind
   * count is bounded by how many measures a person is due for. A caller that hands it a panel would
   * need this reworked — a keyset merge across chunks — rather than wrapped in the helper above.
   */
  async auditEventsForCases(caseIds: string[], limit: number): Promise<AuditEventRow[]> {
    if (caseIds.length === 0) return [];
    const placeholders = caseIds.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
           FROM audit_events WHERE ref_case_id IN (${placeholders}) ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .bind(...caseIds, limit)
      .all<AuditRow>();
    return (results ?? []).map(toAuditEventRow);
  }

  async auditEventsByRun(runId: string): Promise<AuditEventRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
           FROM audit_events WHERE ref_run_id = ? ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(runId)
      .all<AuditRow>();
    return (results ?? []).map(toAuditEventRow);
  }

  async auditEventsByMeasureVersion(measureVersionId: string): Promise<AuditEventRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT occurred_at, event_type, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json
           FROM audit_events WHERE ref_measure_version_id = ? ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(measureVersionId)
      .all<AuditRow>();
    return (results ?? []).map(toAuditEventRow);
  }

  async insertPacketExport(input: PacketExportInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_packet_exports
           (id, packet_type, entity_id, format, generated_by, generated_at, payload_hash, payload_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.packetType,
        input.entityId,
        input.format,
        input.generatedBy,
        new Date().toISOString(),
        input.payloadHash,
        input.payloadSizeBytes,
      )
      .run();
  }

  async caseTimeline(caseId: string): Promise<TimelineEntry[]> {
    // Single-source (audit_events only) — see the Postgres adapter note. The twin case_action is
    // still written by recordCaseEvent's atomic dual-write, just no longer double-listed here.
    const { results } = await this.db
      .prepare(
        `SELECT event_type, actor, occurred_at, payload_json, 'audit_event' AS timeline_source
           FROM audit_events
          WHERE ref_case_id = ? AND event_type <> 'CASE_VIEWED'
          ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(caseId)
      .all<TimelineRow>();
    return (results ?? []).map((r) => ({
      eventType: r.event_type,
      actor: r.actor,
      occurredAt: r.occurred_at,
      payload: { ...(r.payload_json ? JSON.parse(r.payload_json) : {}), timelineSource: r.timeline_source },
    }));
  }
}
