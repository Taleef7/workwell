/**
 * CaseStore contract (#107 cases module). Cases are upserted from a run's outcomes;
 * the idempotency invariant — a rerun never creates a duplicate — is enforced by the
 * UNIQUE key (employee_id, measure_id, evaluation_period) in the adapters.
 */
export interface CaseRecord {
  id: string;
  employeeId: string;
  measureId: string;
  evaluationPeriod: string;
  status: string; // OPEN | RESOLVED | EXCLUDED
  priority: string; // HIGH | MEDIUM | LOW
  assignee: string | null;
  nextAction: string | null;
  currentOutcomeStatus: string;
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedReason: string | null;
  closedBy: string | null;
}

export interface UpsertCaseInput {
  runId: string;
  subjectId: string;
  measureId: string;
  evaluationPeriod: string;
  outcomeStatus: string;
}

export interface CaseQuery {
  /** Concrete statuses to include (e.g. ["OPEN"]); omit for all. */
  statuses?: string[];
  measureId?: string;
  priority?: string;
  assignee?: string;
  /**
   * Compliance-cycle filter (#150 H1):
   *   - omitted / `undefined` / `"all"` / `"current"` → no period filter (every cycle).
   *   - a concrete `YYYY-MM-DD` anchor → exactly that cycle.
   * The worklist's current-cycle default is computed per-measure from today + the measure's
   * cadence in the route (date-driven, Codex P2), not by the store — `"current"` is accepted
   * here as a no-op so a caller forwarding it doesn't accidentally match a literal period.
   */
  period?: string;
  limit?: number;
  offset?: number;
}

/**
 * Mutable case fields an operator action may patch (assign/escalate/outreach/rerun).
 * A nullable field set to `null` clears that column; omit a field to leave it unchanged.
 */
export interface CasePatch {
  status?: string;
  priority?: string;
  assignee?: string | null;
  nextAction?: string;
  currentOutcomeStatus?: string;
  lastRunId?: string;
  closedAt?: string | null;
  closedReason?: string | null;
  closedBy?: string | null;
}

export interface CaseStore {
  /**
   * Upsert a case from one outcome (idempotent on the unique key):
   *   DUE_SOON|OVERDUE|MISSING_DATA → OPEN, EXCLUDED → EXCLUDED, COMPLIANT → resolve
   *   an existing case (no new row). Returns the affected case, or null when COMPLIANT
   *   with no existing case.
   */
  upsertFromOutcome(input: UpsertCaseInput): Promise<CaseRecord | null>;
  getCase(id: string): Promise<CaseRecord | null>;
  listCases(query: CaseQuery): Promise<CaseRecord[]>;
  /** Patch mutable fields (always bumps updated_at); returns the updated row or null. */
  patchCase(id: string, patch: CasePatch): Promise<CaseRecord | null>;
  /** Count cases whose last_run_id is the given run (the run summary's totalCases). */
  countByLastRun(runId: string): Promise<number>;
}
