/**
 * Storage contract — `OutcomeStore` (#104). Per-subject evaluated results for a run.
 * Mirrors the shape of the Postgres `outcomes` table (docs/DATA_MODEL.md), reduced
 * to what the run→evaluate→persist slice needs. Each backend adapter implements it;
 * application code never sees SQL. Canonical schema/migrations stay Taleef-owned.
 */
export interface RecordOutcomeInput {
  runId: string;
  subjectId: string;
  measureId: string;
  /** The run's evaluation period (the canonical outcomes.evaluation_period); defaults to "". */
  evaluationPeriod?: string;
  /** Bucket from the CQL `Outcome Status` define. */
  status: string;
  /** Define-level evidence (`evidence_json` contract, ADR-002). */
  evidence: unknown;
}

export interface OutcomeRecord {
  id: string;
  runId: string;
  subjectId: string;
  measureId: string;
  evaluationPeriod: string;
  status: string;
  evidence: unknown;
  evaluatedAt: string;
}

/** Per-subject outcome history row for a measure (risk-outlook): status + period + evidence. */
export interface MeasureOutcomeRow {
  subjectId: string;
  status: string;
  evaluationPeriod: string;
  evaluatedAt: string;
  evidence: unknown;
}

/** Per-measure outcome history row for one employee (MCP get_employee / check_compliance). */
export interface EmployeeOutcomeRow {
  measureId: string;
  status: string;
  evaluationPeriod: string;
  evaluatedAt: string;
  evidence: unknown;
}

/**
 * Minimal outcome+run projection for the programs analytics (overview/trend/top-drivers):
 * the run's `startedAt` joined per outcome, so aggregation groups by run without an
 * N+1 `listOutcomes` per run. `evidence` is intentionally omitted (not needed for KPIs).
 */
export interface OutcomeWithRun {
  runId: string;
  runStartedAt: string;
  subjectId: string;
  measureId: string;
  status: string;
}

/** Optional measure + day-granular run-period filter pushed into the store query. */
export interface OutcomeMeasureFilter {
  measureId?: string;
  from?: string; // inclusive lower bound (YYYY-MM-DD) on the run's started day
  to?: string; // inclusive upper bound
}

export interface OutcomeStore {
  recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord>;
  listOutcomes(runId: string): Promise<OutcomeRecord[]>;
  /**
   * Outcomes joined to their run (started_at), filtered by measure + run period in SQL —
   * bounds the scan to the selected measure/date range instead of all run history. Used by
   * the programs read models; site filtering stays in the app (employee directory).
   */
  listOutcomesWithRun(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]>;
  /**
   * All outcomes for a measure (bounded scan), with status + evaluation_period + evidence —
   * the per-subject history the risk-outlook analytics group in the app.
   */
  listOutcomesForMeasure(measureId: string): Promise<MeasureOutcomeRow[]>;
  /**
   * The latest `limit` outcomes for one employee (by subjectId), newest-first — the MCP
   * get_employee history and check_compliance lookup. Bounded scan over the outcomes table.
   */
  listOutcomesForEmployee(subjectId: string, limit: number): Promise<EmployeeOutcomeRow[]>;
}
