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
  /**
   * When the outcome was evaluated (ISO-8601). Defaults to now. Pass an explicit value ONLY for
   * backdated synthetic seeding (the trend-history backfill) so historical rows don't out-sort the
   * real latest outcome in `evaluated_at DESC` reads (`listOutcomesForEmployee`, check_compliance).
   */
  evaluatedAt?: string;
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
  /** The run's scope_type — lets rollups exclude single-subject CASE/EMPLOYEE reruns (#150 C4). */
  runScopeType: string;
  /** The run's terminal status — lets order proposals exclude in-flight RUNNING runs (#77 C1). */
  runStatus: string;
  /** The run's `triggered_by` — lets read models exclude synthetic seed runs by identity (not by day). */
  runTriggeredBy: string;
  subjectId: string;
  measureId: string;
  status: string;
}

/** Optional measure + day-granular run-period filter pushed into the store query. */
export interface OutcomeMeasureFilter {
  measureId?: string;
  from?: string; // inclusive lower bound (YYYY-MM-DD) on the run's started day
  to?: string; // inclusive upper bound
  /**
   * Exclude population-scale (`triggered_by='seed:scale'`) runs IN SQL (#185 E13 PR-2). The scale
   * tenant's ~120k rows must never be fetched into app memory by the live read models — they are read
   * only via `aggregateScaleRun` (a bounded GROUP BY). Pushing the predicate into the query, not a JS
   * `.filter()`, is what keeps these surfaces bounded at 120k.
   */
  excludeScale?: boolean;
}

/** Options for the per-measure outcome scan; `excludeScale` drops the scale tenant in SQL (E13 PR-2). */
export interface MeasureScanOptions {
  excludeScale?: boolean;
}

export interface OutcomeStore {
  recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord>;
  /**
   * Batch insert (synthetic trend-history backfill): persist many outcomes for a run in one call.
   * Makes ~100 inserts/run × weeks × measures practical on Neon (the Postgres adapter chunks a
   * multi-row INSERT; the SQLite floor loops inside a single transaction). Equivalent to calling
   * `recordOutcome` per input. A no-op for an empty array.
   */
  recordOutcomes(inputs: RecordOutcomeInput[]): Promise<void>;
  listOutcomes(runId: string): Promise<OutcomeRecord[]>;
  getOutcomeById(id: string): Promise<OutcomeRecord | null>;
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
  listOutcomesForMeasure(measureId: string, opts?: MeasureScanOptions): Promise<MeasureOutcomeRow[]>;
  /**
   * The latest `limit` outcomes for one employee (by subjectId), newest-first — the MCP
   * get_employee history and check_compliance lookup. Bounded scan over the outcomes table.
   */
  listOutcomesForEmployee(subjectId: string, limit: number): Promise<EmployeeOutcomeRow[]>;
  /**
   * Aggregate a population-scale run's outcomes by (location, provider, status), parsing the encoded
   * subject_id (`mhn|Lxx|Pxx|n`) — a single GROUP BY that never materializes the per-subject rows.
   * Used by the hierarchy rollup + programs KPIs for the scale tenant (#185 E13 PR-2).
   */
  aggregateScaleRun(runId: string): Promise<ScaleGroupCount[]>;
}

/** A grouped count from a scale run: outcomes per (location, provider, status). The SQL aggregation
 *  returns O(locations×providers×statuses) rows — never O(subjects) — so app memory stays bounded. */
export interface ScaleGroupCount {
  locationId: string;
  providerId: string;
  status: string;
  count: number;
}
