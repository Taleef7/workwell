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
   * real latest outcome in `evaluated_at DESC` reads (`listOutcomesForEmployee`,
   * `listLatestFinalizedOutcomePerMeasure` — the compliance-api / MCP / CDS latest-answer reads).
   */
  evaluatedAt?: string;
  /**
   * The subject was outside this measure's initial population when the run evaluated them (ADR-079).
   *
   * The pipeline reads it off the executor's own `inInitialPopulation` for an OFFICIALLY ROUTED
   * measure only, and "outside" means no rate admits them (`worstOutcome`). Persisted because the
   * status cannot carry it: ADR-078 records such a subject as MISSING_DATA, so a reader counting
   * statuses cannot tell "not this measure's concern" from "in the population, result missing" —
   * and the second is work while the first is not. Undefined means the run did not record it (every
   * row written before the column existed), which readers treat as not-out-of-population.
   */
  outOfPopulation?: boolean;
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
  /** See {@link RecordOutcomeInput.outOfPopulation}. Undefined ⇒ the run did not record it. */
  outOfPopulation?: boolean;
}

/** Per-subject outcome history row for a measure (risk-outlook): status + period + evidence. */
export interface MeasureOutcomeRow {
  subjectId: string;
  status: string;
  evaluationPeriod: string;
  evaluatedAt: string;
  evidence: unknown;
  /** See {@link RecordOutcomeInput.outOfPopulation}. Undefined ⇒ the run did not record it. */
  outOfPopulation?: boolean;
}

/** Per-measure outcome history row for one employee (MCP get_employee / check_compliance). */
export interface EmployeeOutcomeRow {
  /**
   * The run that produced this outcome. Added for the compliance API (ADR-061): a row exists as soon as
   * the evaluation loop writes it, which is BEFORE the run reaches a terminal status — and before
   * `/finalize` in the QRDA import flow. A public contract must not serve a mid-run row as the persisted
   * answer, and it cannot tell without this (review, #399).
   */
  runId: string;
  measureId: string;
  status: string;
  evaluationPeriod: string;
  evaluatedAt: string;
  evidence: unknown;
}

/**
 * Minimal outcome+run projection for the programs analytics (overview/trend/top-drivers):
 * the run's `startedAt` joined per outcome, so aggregation groups by run without an
 * N+1 `listOutcomes` per run. `evidence` is intentionally omitted (not needed for KPIs) — which is
 * exactly why `outOfPopulation` is a COLUMN here and not something the reader derives: the one fact
 * these aggregates need out of the evidence, carried at a byte instead of a blob (ADR-079).
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
  /** See {@link RecordOutcomeInput.outOfPopulation}. Undefined ⇒ the run did not record it. */
  outOfPopulation?: boolean;
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
  /**
   * Exclude synthetic trend-history (`triggered_by='seed:trend-history'`) runs IN SQL (Fable M16). The
   * live read models keep only the latest population run per measure (`latestRunRows`), so the backdated
   * trend-history outcomes are fetched then discarded in JS — pure overhead that grows unbounded. The
   * roster/hierarchy/programs-overview reads pass this so those rows never leave the DB.
   */
  excludeTrendHistory?: boolean;
  /**
   * Restrict to these runs IN SQL (`run_id = ANY(...)`). The read models that reduce to "the newest
   * run(s) per measure" resolve those run ids first with {@link OutcomeStore.listLatestPopulationRuns}
   * — a handful of rows — and then fetch ONLY those runs' outcomes through this, so a page reads the
   * rows it shows and not every retained run's. An empty array matches nothing (never "everything").
   */
  runIds?: string[];
}

/**
 * How many of the newest qualifying runs {@link OutcomeStore.listLatestPopulationRuns} probes before
 * resolving what is left by one bounded per-measure query. Both stores honour it; the store contract
 * seeds more runs than this so the second path is exercised, not merely present.
 */
export const LATEST_RUN_PROBE_BUDGET = 25;

/**
 * One (measure, run) winner from {@link OutcomeStore.listLatestPopulationRuns}: the run carries the same
 * projection `OutcomeWithRun` does, so a caller can apply `isPopulationRun`/`isCompletedRun` as
 * defense-in-depth without a second read.
 */
export interface LatestPopulationRun {
  measureId: string;
  runId: string;
  runStartedAt: string;
  runScopeType: string;
  runStatus: string;
  runTriggeredBy: string;
}

/** Options for the per-measure evidence-rich outcome scan. */
export interface MeasureScanOptions {
  /** Drop the scale tenant's mhn-prefixed subjects in SQL (E13 PR-2). */
  excludeScale?: boolean;
  /**
   * Join to runs and retain only terminal successful population runs in SQL. "Population" excludes
   * CASE/EMPLOYEE scopes; "successful terminal" is COMPLETED/PARTIAL_FAILURE. Risk outlook uses this
   * to keep evidence without an unbounded listOutcomes-per-run hydration pass.
   */
  successfulPopulationOnly?: boolean;
}

export interface OutcomeStore {
  recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord>;
  /**
   * Batch insert (synthetic trend-history backfill): persist many outcomes for a run in one call.
   * Makes ~100 inserts/run × weeks × measures practical on Neon (the Postgres adapter chunks a
   * multi-row INSERT; the SQLite floor loops inside a single transaction). Equivalent to calling
   * `recordOutcome` per input, and returns the same records IN INPUT ORDER — the run pipeline persists
   * a chunk in one call and still has to fingerprint each row it wrote for the incremental cache.
   * Returns `[]` for an empty input (a no-op, which must not throw).
   */
  recordOutcomes(inputs: RecordOutcomeInput[]): Promise<OutcomeRecord[]>;
  /**
   * Outcomes for one run, oldest-first. Pass `opts.limit`/`opts.offset` to page the scan (Fable H4):
   * the run-detail grid + the outcomes CSV must never materialize a `seed:scale` run's 120k rows in the
   * single-replica worker. Omitting `opts` returns every row (back-compat, small runs only).
   *
   * `opts.measureId` narrows the scan to ONE measure of the run. An ALL_PROGRAMS run holds a row per
   * (subject, measure) pair, so a caller that sums a run's evidence without saying which measure it
   * means sums every measure into one number and serves it under each measure's name — which is what
   * the programs overview did until 2026-09-08. Pushed into SQL rather than filtered after the read:
   * on the pilot's six-measure nightly the app-side filter would page 120,000 rows once per measure.
   *
   * `opts.subjectId` narrows it to ONE subject, which with `measureId` and `limit: 1` is the single row
   * a case detail needs. That page used to read the run unpaged and `.find()` the row in JavaScript:
   * against a run holding 87,000 rows it measured 43s on a cold read and ~4s warm, for one row. Both
   * filters are index-friendly — `outcomes` carries `(subject_id, measure_id, evaluation_period)` and
   * `(run_id)`.
   */
  listOutcomes(
    runId: string,
    opts?: { limit?: number; offset?: number; measureId?: string; subjectId?: string },
  ): Promise<OutcomeRecord[]>;
  getOutcomeById(id: string): Promise<OutcomeRecord | null>;
  /**
   * Delete outcome rows older than `cutoff`, KEEPING four things (ADR-073, amended by ADR-077 d3):
   *  - the newest USABLE row per `(subject_id, measure_id, evaluation_period)` — from a COMPLETED or
   *    PARTIAL_FAILURE run and not an evaluation error — AND the newest row regardless, whatever their
   *    age. Two keep sets, because a FAILED rerun or an engine failure must not evict the last finalized
   *    clinical answer, while a key with no usable row still keeps its newest so no roster cell goes
   *    blank. **Per PERIOD, not merely per measure**: a calendar-year eCQM's whole 2027 evidence is
   *    superseded by the first 2028 run, and keeping only the newest-per-measure would delete every
   *    2027 row months before anyone could be asked to justify a 2027 rate.
   *  - every row of a run that is still QUEUED/RUNNING/REQUESTED — an in-flight run is never compacted.
   *  - every row a CASE cites — matched on `(run_id, subject_id, measure_id)`, so it protects that
   *    case's own evidence rather than the other 99,999 rows its run happens to contain. Every case,
   *    not only open ones: a closed case's detail page still resolves its outcome through
   *    `last_run_id`, and a case somebody resolved is exactly the record re-read when a number is
   *    challenged.
   *  - everything at or after `cutoff`.
   *
   * Returns the number of rows deleted. Idempotent: a second call with the same cutoff deletes
   * nothing. **No schema change** — a DELETE against the existing indexes.
   *
   * The case exclusion is evaluated IN SQL rather than passed in as a list of ids. A list has to be
   * read with a limit, and a limit that silently truncates deletes exactly the evidence the exclusion
   * exists to protect — with no error, because the read succeeded.
   *
   * The run rows themselves are never touched. A run's summary counts live on the run and in the
   * quality snapshots, so a compacted run still reports what it found (ADR-073).
   */
  compactOlderThan(cutoff: string): Promise<number>;
  /**
   * The distinct measure ids present in a run, capped at `limit` (default 2) — a bounded
   * `SELECT DISTINCT measure_id … LIMIT` used by the QRDA / MeasureReport endpoints to enforce the
   * single-measure precondition WITHOUT loading the run's outcome rows (Fable H4). Two is enough to
   * distinguish "single measure" from "multi-measure".
   */
  distinctMeasuresForRun(runId: string, limit?: number): Promise<string[]>;
  /**
   * Outcomes joined to their run (started_at), filtered by measure + run period in SQL —
   * bounds the scan to the selected measure/date range instead of all run history. Used by
   * the programs read models; site filtering stays in the app (employee directory).
   */
  listOutcomesWithRun(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]>;
  /**
   * The outcomes of ONLY the latest terminal population run per measure (perf #233 residual). Same
   * `OutcomeWithRun` projection as {@link listOutcomesWithRun} and the same measure/date/exclude
   * filters, but the "latest completed population run per measure" reduction is pushed INTO SQL
   * instead of fetching every population run's rows across all history and reducing in JS via
   * `latestRunRows`. "Population" = a non-`CASE`/`EMPLOYEE` scope (case-insensitive); "terminal" =
   * `COMPLETED`/`PARTIAL_FAILURE` (case-insensitive) — the exact predicates the roster + hierarchy
   * read models already apply after `listOutcomesWithRun`. Per measure the newest run wins by
   * `started_at DESC`, tie-broken by `run_id DESC`.
   *
   * The result is a strict subset of `listOutcomesWithRun(filter).filter(pop && completed)` — exactly
   * the rows that survive that filter → group-by-measure → `latestRunRows` — so a caller that feeds
   * this through the same downstream reduction gets a byte-identical result while shipping
   * O(measures × subjects-of-one-run) rows over the wire instead of O(all population runs × subjects).
   * (On a true `started_at` tie the JS reference's insertion-order tiebreak and this method's
   * `run_id DESC` tiebreak could pick different runs; sequential run creation makes exact ties
   * unreachable in practice.)
   *
   * Since 2026-09-10 no read model calls this: the reduction it performs scans every qualifying
   * outcome row to name a run, and {@link listLatestPopulationRuns} names it from the runs table. It
   * stays as the store contract's ORACLE — the reference the walk is asserted equal to on both stores.
   */
  listLatestPopulationOutcomes(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]>;
  /**
   * For each requested measure, its newest `perMeasure` (default 1) terminal population runs that hold
   * at least one outcome row for it — the (measure, run) WINNERS, without any outcome rows.
   *
   * This answers the question every roster-wide read model asks first ("which run is the latest for
   * this measure?") without reading outcome rows. {@link listLatestPopulationOutcomes} answers it by
   * reducing over every qualifying outcome row — on the pilot that is every retained run's 120,000
   * rows scanned to pick one run id — and `listOutcomesWithRun` + `latestRunRows` answered it by
   * shipping those rows to the worker. Here the newest {@link LATEST_RUN_PROBE_BUDGET} qualifying runs
   * are read from the runs table and walked newest-first, each probed once (one EXISTS query) for the
   * requested measures it holds, so the common case — the newest ALL_PROGRAMS run holds every routed
   * measure — is two small queries. A measure the budget cannot settle (routed and not yet run; last
   * evaluated further back than the budget) is resolved by one bounded query over that measure's own
   * index entries, so the worst case is a handful of round trips plus one index scan — never a probe
   * per run across the history.
   *
   * Same predicates as `listLatestPopulationOutcomes`: population scope allowlist (MEASURE, ALL_PROGRAMS),
   * terminal status (COMPLETED, PARTIAL_FAILURE), the day-granular `from`/`to` window on the run's
   * started day, and the `excludeScale`/`excludeTrendHistory` trigger exclusions (a NULL triggered_by is
   * excluded under either, exactly as the sibling reads exclude it); `filter.measureId` and
   * `filter.runIds` are ignored (the measure list is the argument). Ordering: newest first per measure
   * by `started_at DESC, run_id DESC`, the tie-break `listLatestPopulationOutcomes` uses. A measure
   * with no qualifying run simply has no entry. The store contract asserts that, per measure, the first
   * winner here is the run `listLatestPopulationOutcomes` returns rows for — on both paths.
   */
  listLatestPopulationRuns(measureIds: readonly string[], filter: OutcomeMeasureFilter, perMeasure?: number): Promise<LatestPopulationRun[]>;
  /**
   * All outcomes for a measure (bounded scan), with status + evaluation_period + evidence. Pass
   * `successfulPopulationOnly` for the risk-outlook history: filtering happens in the same query.
   */
  listOutcomesForMeasure(measureId: string, opts?: MeasureScanOptions): Promise<MeasureOutcomeRow[]>;
  /**
   * The latest `limit` outcomes for one employee (by subjectId), newest-first — the employee-profile
   * history, identity resolution, and the compliance API's windowed `latest` scan (which applies its
   * own finalization check per row). Bounded scan over the outcomes table. The MCP tools moved to
   * {@link listLatestFinalizedOutcomePerMeasure} (#491) — a raw read here has no run-status filter.
   */
  listOutcomesForEmployee(subjectId: string, limit: number): Promise<EmployeeOutcomeRow[]>;
  /**
   * One row per measure: the subject's newest outcome whose run is TERMINAL (`COMPLETED` or
   * `PARTIAL_FAILURE`) — the CDS Hooks read (#470) and the MCP check_compliance / get_employee
   * reads (#491), bounded by the measure count instead of the
   * subject's whole outcome history. A measure whose only rows belong to unfinished runs is ABSENT
   * (a mid-run row is not the persisted answer — the compliance-api FINAL rule), never served stale.
   * Newest = `evaluated_at DESC` tie-broken by `id DESC` — the same `(evaluated_at, id)` composite
   * `listOutcomes` pages by, read in the opposite direction.
   */
  listLatestFinalizedOutcomePerMeasure(subjectId: string): Promise<EmployeeOutcomeRow[]>;
  /**
   * Whether ANY outcome row exists for this subject, regardless of run status — the cheap existence
   * probe that lets a caller of {@link listLatestFinalizedOutcomePerMeasure} tell "no run has ever
   * touched this subject" apart from "rows exist but none is finalized yet" (#470). The CDS route
   * audits those two absences differently.
   */
  hasOutcomes(subjectId: string): Promise<boolean>;
  /**
   * Aggregate a population-scale run's outcomes by (location, provider, status), parsing the encoded
   * subject_id (`mhn|Lxx|Pxx|n`) — a single GROUP BY that never materializes the per-subject rows.
   * Used by the hierarchy rollup + programs KPIs for the scale tenant (#185 E13 PR-2).
   */
  aggregateScaleRun(runId: string): Promise<ScaleGroupCount[]>;
  /**
   * Status histogram for one run — a single bounded `GROUP BY (status, out_of_population)` (+ MAX(evaluated_at)), returning
   * O(statuses) rows, never the per-subject rows. The run-list/summary read models use this instead of
   * `listOutcomes(runId)`: the `/api/runs` list previously loaded every outcome row per run just to
   * count them, which is O(120k) for each `seed:scale` run and pushed `?limit=20` past the 60s gateway
   * timeout. (Post-audit fix; same bounded-aggregation discipline as `aggregateScaleRun`.)
   */
  countOutcomesByStatus(runId: string): Promise<OutcomeStatusCount[]>;
}

/** A per-status count for one run (a bounded GROUP BY). `latestEvaluatedAt` is MAX(evaluated_at) within
 *  the group, so the run summary can derive `dataFreshAsOf` without materializing any outcome rows. */
export interface OutcomeStatusCount {
  status: string;
  count: number;
  latestEvaluatedAt: string | null;
  /**
   * Part of the GROUP BY key since ADR-079, so a caller can tell a run's MISSING_DATA rows apart
   * without reading any of them: `true` are subjects the measure's logic put outside its population,
   * `undefined` a run that predates the column. A caller that only sums counts is unaffected — the
   * totals are identical; a caller computing a RATE must not put the `true` rows in its denominator.
   */
  outOfPopulation?: boolean;
}

/** A grouped count from a scale run: outcomes per (location, provider, status). The SQL aggregation
 *  returns O(locations×providers×statuses) rows — never O(subjects) — so app memory stays bounded. */
export interface ScaleGroupCount {
  locationId: string;
  providerId: string;
  status: string;
  count: number;
}
