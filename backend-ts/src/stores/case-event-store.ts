/**
 * CaseEventStore contract (#107 cases actions) — the append-only side of a case:
 * operator/system actions (`case_actions`) + the audit ledger (`audit_events`), and
 * the merged case timeline the detail page renders.
 *
 * Mirrors the Java CaseFlowService: every mutating action writes BOTH a case_action
 * (the operator-facing record) and an audit_event (the immutable ledger; CLAUDE.md
 * hard rule — every state change writes audit_event). The timeline is
 *   audit_events (excl CASE_VIEWED) ∪ case_actions  ordered by occurred_at, id.
 *
 * It is also the project's de-facto audit store (it owns the audit_events table): the
 * audit CSV export, the by-run / by-measure-version ledger reads for auditor packets,
 * and the audit_packet_exports record all live here (#108).
 */
export interface InsertActionInput {
  caseId: string;
  actionType: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface AppendAuditInput {
  eventType: string;
  entityType: string;
  entityId: string | null;
  actor: string;
  refRunId: string | null;
  refCaseId: string | null;
  refMeasureVersionId: string | null;
  payload: Record<string, unknown>;
}

/** One merged timeline entry (matches the Java AuditEvent timeline projection). */
export interface TimelineEntry {
  eventType: string;
  actor: string | null;
  occurredAt: string;
  /** Action/audit payload, plus a `timelineSource` discriminator ("audit_event" | "case_action"). */
  payload: Record<string, unknown>;
}

/** A raw audit_events row (the audit CSV export source), oldest-first. */
export interface AuditEventRow {
  occurredAt: string;
  eventType: string;
  actor: string | null;
  refRunId: string | null;
  refCaseId: string | null;
  refMeasureVersionId: string | null;
  payload: Record<string, unknown>;
}

/** One audit_packet_exports row to record (#108 auditor packets) — see docs/DATA_MODEL.md §3.15. */
export interface PacketExportInput {
  packetType: string;
  entityId: string;
  format: string;
  generatedBy: string;
  /** `sha256:<hex>` digest of the serialized packet bytes. */
  payloadHash: string;
  payloadSizeBytes: number;
}

export interface CaseEventStore {
  insertAction(input: InsertActionInput): Promise<void>;
  appendAudit(input: AppendAuditInput): Promise<void>;
  /**
   * Write a case_action AND its audit_event atomically (D1 batch on the floor,
   * a single-client transaction on the ceiling) so the two halves of a mutating
   * action can never be split. Callers run this BEFORE patching case state, so a
   * partial failure can never leave a state change without its ledger entry.
   */
  recordCaseEvent(input: { action: InsertActionInput; audit: AppendAuditInput }): Promise<void>;
  /** Oldest-first case timeline, sourced solely from audit_events (CASE_VIEWED excluded). The
   *  twin case_action of each action is intentionally not listed — audit_events is the canonical
   *  ledger and UNION-ing both arms double-counted every action on the case-detail timeline. */
  caseTimeline(caseId: string): Promise<TimelineEntry[]>;
  /**
   * All audit events, oldest-first (the audit CSV export); capped at `limit` from `offset`.
   * `offset` lets the export page the ledger so it never materializes the whole table (#150 M9).
   */
  listAuditEvents(limit?: number, offset?: number): Promise<AuditEventRow[]>;
  /** Audit events for one run (ref_run_id), oldest-first — the run auditor packet ledger. */
  auditEventsByRun(runId: string): Promise<AuditEventRow[]>;
  /** The most recent audit_events of a given event_type, NEWEST-first, bounded by limit.
   *  Lets event-type-scoped read models (e.g. campaigns) avoid scanning the whole ledger and
   *  avoid the oldest-first truncation cliff of listAuditEvents. */
  recentAuditEventsByType(eventType: string, limit: number): Promise<AuditEventRow[]>;
  /** Newest-first, bounded — the admin audit viewer's recent-activity window (no whole-ledger scan). */
  recentAuditEvents(limit: number): Promise<AuditEventRow[]>;
  /** Audit events for a set of case ids, newest-first, bounded — the employee-profile activity feed
   *  (pushes the ref_case_id filter + LIMIT into SQL instead of materializing the whole ledger). */
  auditEventsForCases(caseIds: string[], limit: number): Promise<AuditEventRow[]>;
  /** Audit events for one measure version (ref_measure_version_id), oldest-first — the measure-version packet ledger. */
  auditEventsByMeasureVersion(measureVersionId: string): Promise<AuditEventRow[]>;
  /** Record a generated auditor packet in audit_packet_exports (#108). */
  insertPacketExport(input: PacketExportInput): Promise<void>;
  /** True once an OUTREACH_SENT action exists — the precondition for a delivery-state update. */
  hasOutreachSent(caseId: string): Promise<boolean>;
  /**
   * Per-case count of OUTREACH_SENT actions for the given case ids (the worklist's
   * outreachRecordCount). Returns a map keyed by case id; absent ids count as 0.
   * Empty input returns {} (no query).
   */
  outreachSentCounts(caseIds: string[]): Promise<Record<string, number>>;
  /**
   * The `deliveryStatus` from the most recent OUTREACH_DELIVERY_UPDATED / OUTREACH_SENT
   * case_action payload (CaseDetail.latestOutreachDeliveryStatus), or null if none.
   */
  latestOutreachDeliveryStatus(caseId: string): Promise<string | null>;
}
