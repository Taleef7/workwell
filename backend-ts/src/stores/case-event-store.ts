/**
 * CaseEventStore contract (#107 cases actions) — the append-only side of a case:
 * operator/system actions (`case_actions`) + the audit ledger (`audit_events`), and
 * the merged case timeline the detail page renders.
 *
 * Mirrors the Java CaseFlowService: every mutating action writes BOTH a case_action
 * (the operator-facing record) and an audit_event (the immutable ledger; CLAUDE.md
 * hard rule — every state change writes audit_event). The timeline is
 *   audit_events (excl CASE_VIEWED) ∪ case_actions  ordered by occurred_at, id.
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
  /** Merged, oldest-first timeline for one case (CASE_VIEWED audit rows excluded). */
  caseTimeline(caseId: string): Promise<TimelineEntry[]>;
  /** True once an OUTREACH_SENT action exists — the precondition for a delivery-state update. */
  hasOutreachSent(caseId: string): Promise<boolean>;
  /**
   * The `deliveryStatus` from the most recent OUTREACH_DELIVERY_UPDATED / OUTREACH_SENT
   * case_action payload (CaseDetail.latestOutreachDeliveryStatus), or null if none.
   */
  latestOutreachDeliveryStatus(caseId: string): Promise<string | null>;
}
