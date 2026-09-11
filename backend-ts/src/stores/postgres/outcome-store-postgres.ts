/**
 * Postgres-ceiling implementation of the `OutcomeStore` contract (#104).
 * Same contract as the SQLite floor; `evidence` lives in a native JSONB column
 * (TEXT JSON on the floor). Schema-qualified to avoid the canonical `public.outcomes`.
 */
import { isUuid, type PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import { LATEST_RUN_PROBE_BUDGET } from "../outcome-store.ts";
import type {
  OutcomeRecord,
  OutcomeStore,
  RecordOutcomeInput,
  OutcomeWithRun,
  OutcomeMeasureFilter,
  LatestPopulationRun,
  MeasureOutcomeRow,
  EmployeeOutcomeRow,
  ScaleGroupCount,
  OutcomeStatusCount,
  MeasureScanOptions,
} from "../outcome-store.ts";

interface OutcomeRow {
  id: string;
  run_id: string;
  subject_id: string;
  measure_id: string;
  evaluation_period: string;
  status: string;
  evidence_json: unknown;
  evaluated_at: Date | string;
  out_of_population: boolean | null;
}

/** NULL means the run did not record it (ADR-079) — not the same statement as false. */
const flagOf = (v: boolean | null | undefined): boolean | undefined => (v === null || v === undefined ? undefined : v);

const toRecord = (r: OutcomeRow): OutcomeRecord => ({
  id: r.id,
  runId: r.run_id,
  subjectId: r.subject_id,
  measureId: r.measure_id,
  evaluationPeriod: r.evaluation_period,
  status: r.status,
  // pg returns JSONB already parsed.
  evidence: r.evidence_json,
  evaluatedAt: r.evaluated_at instanceof Date ? r.evaluated_at.toISOString() : r.evaluated_at,
  outOfPopulation: flagOf(r.out_of_population),
});

const T = `${SPIKE_SCHEMA}.outcomes`;
const CASES_TABLE = `${SPIKE_SCHEMA}.cases`;
const RUNS_TABLE = `${SPIKE_SCHEMA}.runs`;

export class PgOutcomeStore implements OutcomeStore {
  constructor(private readonly pool: PgPool) {}

  /**
   * In-process memo of `aggregateScaleRun` (perf #233). A COMPLETED `seed:scale` run is written once
   * and never re-evaluated, so its (location, provider, status) aggregation is a pure function of an
   * immutable runId — cached so the hierarchy/programs reads don't repeat the 120k-row GROUP BY per
   * request. Bounded by the number of distinct COMPLETED scale runs ever queried (~one per runnable
   * measure; grows only on a re-seed, which mints new runIds). The store is a long-lived singleton
   * (one per env, see stores/factory.ts), so the cache persists across requests.
   */
  private readonly scaleCache = new Map<string, ScaleGroupCount[]>();

  async recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord> {
    const id = crypto.randomUUID();
    const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
    const evaluationPeriod = input.evaluationPeriod ?? "";
    await this.pool.query(
      `INSERT INTO ${T} (id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at, out_of_population)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [id, input.runId, input.subjectId, input.measureId, evaluationPeriod, input.status, JSON.stringify(input.evidence ?? {}), evaluatedAt, input.outOfPopulation ?? null],
    );
    return {
      id,
      runId: input.runId,
      subjectId: input.subjectId,
      measureId: input.measureId,
      evaluationPeriod,
      status: input.status,
      evidence: input.evidence ?? {},
      evaluatedAt,
      outOfPopulation: input.outOfPopulation,
    };
  }

  async recordOutcomes(inputs: RecordOutcomeInput[]): Promise<OutcomeRecord[]> {
    if (inputs.length === 0) return [];
    // Chunked multi-row INSERT so the trend-history backfill (~100 rows/run × weeks × measures)
    // is a handful of round-trips on Neon, not thousands. 9 columns/row × CHUNK must stay well
    // under Postgres' 65535 bind-parameter cap; 500 rows = 4500 params, comfortably safe.
    const CHUNK = 500;
    const defaultEvaluatedAt = new Date().toISOString();
    // Ids and timestamps are minted HERE so the returned records are exactly the rows written, in input
    // order. A `RETURNING` clause would give the ids back but not the order guarantee for free.
    const records: OutcomeRecord[] = inputs.map((input) => ({
      id: crypto.randomUUID(),
      runId: input.runId,
      subjectId: input.subjectId,
      measureId: input.measureId,
      evaluationPeriod: input.evaluationPeriod ?? "",
      status: input.status,
      evidence: input.evidence ?? {},
      evaluatedAt: input.evaluatedAt ?? defaultEvaluatedAt,
      outOfPopulation: input.outOfPopulation,
    }));
    // ONE transaction across every chunk. The run pipeline persists a whole evaluation chunk (500
    // subjects x the measures in the run) in one call and then advances its progress by the returned
    // length — so when the third of six INSERTs failed, 1,000 rows were durably in the table while the
    // pipeline's terminal audit reported the chunk as unevaluated (Codex review, #528). All or nothing
    // is the guarantee the caller's accounting assumes; a single client with BEGIN/COMMIT is how the
    // case-event store already gives it for action + audit.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (let start = 0; start < records.length; start += CHUNK) {
        const chunk = records.slice(start, start + CHUNK);
        const binds: unknown[] = [];
        const tuples = chunk.map((record) => {
          const o = binds.length;
          binds.push(
            record.id,
            record.runId,
            record.subjectId,
            record.measureId,
            record.evaluationPeriod,
            record.status,
            JSON.stringify(record.evidence),
            record.evaluatedAt,
            record.outOfPopulation ?? null,
          );
          return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}::jsonb, $${o + 8}, $${o + 9})`;
        });
        await client.query(
          `INSERT INTO ${T} (id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at, out_of_population)
           VALUES ${tuples.join(", ")}`,
          binds,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return records;
  }

  async listOutcomes(
    runId: string,
    opts?: { limit?: number; offset?: number; measureId?: string; subjectId?: string },
  ): Promise<OutcomeRecord[]> {
    // Native UUID column: a malformed run id yields no rows on the floor, so don't
    // let Postgres throw `invalid input syntax for type uuid` — match the contract.
    if (!isUuid(runId)) return [];
    // Optional LIMIT/OFFSET paging (Fable H4) — the id tiebreak makes paging deterministic when many
    // rows share an evaluated_at (all of a run's outcomes are stamped within the same run).
    const binds: unknown[] = [runId];
    // Narrowed BEFORE the page window, so offsets walk the measure's rows and not the run's.
    let where = opts?.measureId != null ? ` AND measure_id = $${binds.push(opts.measureId)}` : "";
    if (opts?.subjectId != null) where += ` AND subject_id = $${binds.push(opts.subjectId)}`;
    let page = "";
    if (opts?.limit != null) page += ` LIMIT $${binds.push(Math.max(0, opts.limit))}`;
    if (opts?.offset != null) page += ` OFFSET $${binds.push(Math.max(0, opts.offset))}`;
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at, out_of_population
         FROM ${T} WHERE run_id = $1${where} ORDER BY evaluated_at ASC, id ASC${page}`,
      binds,
    );
    return rows.map(toRecord);
  }

  async distinctMeasuresForRun(runId: string, limit = 2): Promise<string[]> {
    if (!isUuid(runId)) return [];
    const { rows } = await this.pool.query<{ measure_id: string }>(
      `SELECT DISTINCT measure_id FROM ${T} WHERE run_id = $1 LIMIT $2`,
      [runId, Math.max(1, limit)],
    );
    return rows.map((r) => r.measure_id);
  }

  async getOutcomeById(id: string): Promise<OutcomeRecord | null> {
    // Native UUID column — a malformed id yields no rows on the floor; don't let Postgres throw.
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at, out_of_population
         FROM ${T} WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * ADR-073 retention — see the SQLite floor for the shape and why both exclusions are expressed in
   * SQL rather than read into memory.
   *
   * `DISTINCT ON` is the Postgres form of "the newest row per (subject, measure, period)"; the floor
   * uses a correlated MAX because SQLite has no DISTINCT ON. The tie-break is `id DESC` on BOTH stores
   * — see the store contract's tied-timestamp case — so two rows stamped the same instant resolve the
   * same way on the ceiling and the floor.
   *
   * **The query is unchanged; `spike_outcomes_keepset_idx` is what ADR-073 d1 was waiting for.** The
   * index was added in the same commit as Maui's retention window, and it is worth recording what it
   * actually does, because the obvious-looking rewrite makes things worse. Measured on postgres:16
   * over 300,000 outcome rows (20,000 subjects × 5 measures × 3 runs — the pilot's shape), each
   * deleting the same 200,000 rows, EXPLAIN ANALYZE inside a rolled-back transaction:
   *
   * | form | plan | time |
   * |---|---|---|
   * | this query, no index | external merge `Sort`, 19 MB **to disk** | 523 ms |
   * | this query, with the index | `Index Only Scan using spike_outcomes_keepset_idx` | **274 ms** |
   * | `EXISTS (a newer row for this key)` instead, with the index | `Hash Semi Join`, two seq scans, index unused | 516 ms |
   *
   * So the whole-table sort ADR-073 d1 named is real, the index removes it, and rewriting the
   * predicate as a correlated existence check — which reads like the more index-friendly form — is a
   * pessimization the planner does not use the index for at all. The rewrite was written, measured,
   * and reverted; this comment is here so it does not get written again.
   *
   * 2026-09-08 (ADR-077 d3): a second keep set joined to `runs` protects the newest USABLE row (from a
   * COMPLETED/PARTIAL_FAILURE run, not an evaluation error), and rows of an in-flight run are never
   * candidates. The run-status join is a NEW cost on the pilot's table and has NOT been re-measured with
   * EXPLAIN ANALYZE at scale — recorded here as unmeasured, not as index-friendly, until it is.
   */
  async compactOlderThan(cutoff: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${T} o
        WHERE o.evaluated_at < $1
          AND o.run_id IN (SELECT id FROM ${RUNS_TABLE} WHERE UPPER(status) IN ('COMPLETED','PARTIAL_FAILURE','FAILED','CANCELLED'))
          AND o.id NOT IN (
            SELECT DISTINCT ON (o3.subject_id, o3.measure_id, o3.evaluation_period) o3.id
              FROM ${T} o3
              JOIN ${RUNS_TABLE} r3 ON r3.id = o3.run_id
             WHERE UPPER(r3.status) IN ('COMPLETED','PARTIAL_FAILURE')
               AND NOT (o3.evidence_json ? 'evaluationError')
             ORDER BY o3.subject_id, o3.measure_id, o3.evaluation_period, o3.evaluated_at DESC, o3.id DESC
          )
          AND o.id NOT IN (
            SELECT DISTINCT ON (subject_id, measure_id, evaluation_period) id
              FROM ${T}
             ORDER BY subject_id, measure_id, evaluation_period, evaluated_at DESC, id DESC
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${CASES_TABLE} c
             WHERE c.last_run_id = o.run_id
               AND c.employee_id = o.subject_id
               AND c.measure_id = o.measure_id
          )`,
      [cutoff],
    );
    return rowCount ?? 0;
  }

  async listOutcomesForEmployee(subjectId: string, limit: number): Promise<EmployeeOutcomeRow[]> {
    const { rows } = await this.pool.query<{
      run_id: string;
      measure_id: string;
      status: string;
      evaluation_period: string;
      evaluated_at: Date | string;
      evidence_json: unknown;
    }>(
      `SELECT run_id, measure_id, status, evaluation_period, evaluated_at, evidence_json
         FROM ${T} WHERE subject_id = $1 ORDER BY evaluated_at DESC LIMIT $2`,
      [subjectId, Math.max(1, limit)],
    );
    return rows.map((r) => ({
      runId: r.run_id,
      measureId: r.measure_id,
      status: r.status,
      evaluationPeriod: r.evaluation_period,
      evaluatedAt: r.evaluated_at instanceof Date ? r.evaluated_at.toISOString() : r.evaluated_at,
      evidence: r.evidence_json,
    }));
  }

  async listLatestFinalizedOutcomePerMeasure(subjectId: string): Promise<EmployeeOutcomeRow[]> {
    const { rows } = await this.pool.query<{
      run_id: string;
      measure_id: string;
      status: string;
      evaluation_period: string;
      evaluated_at: Date | string;
      evidence_json: unknown;
    }>(
      // Winner IDS first over narrow columns, wide row joined back — the history-sized DISTINCT ON
      // sort never carries `evidence_json`; only the O(measures) survivors are fetched wide (#486
      // review, same shape as the SQLite floor).
      `SELECT o.run_id, o.measure_id, o.status, o.evaluation_period, o.evaluated_at, o.evidence_json
         FROM ${T} o
         JOIN (SELECT DISTINCT ON (o2.measure_id) o2.id
                 FROM ${T} o2 JOIN ${SPIKE_SCHEMA}.runs r ON r.id = o2.run_id
                WHERE o2.subject_id = $1 AND UPPER(r.status) IN ('COMPLETED', 'PARTIAL_FAILURE')
                ORDER BY o2.measure_id, o2.evaluated_at DESC, o2.id DESC) pick ON pick.id = o.id`,
      [subjectId],
    );
    return rows.map((r) => ({
      runId: r.run_id,
      measureId: r.measure_id,
      status: r.status,
      evaluationPeriod: r.evaluation_period,
      evaluatedAt: r.evaluated_at instanceof Date ? r.evaluated_at.toISOString() : r.evaluated_at,
      evidence: r.evidence_json,
    }));
  }

  async hasOutcomes(subjectId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ one: number }>(
      `SELECT 1 AS one FROM ${T} WHERE subject_id = $1 LIMIT 1`,
      [subjectId],
    );
    return rows.length > 0;
  }

  async listOutcomesForMeasure(measureId: string, opts?: MeasureScanOptions): Promise<MeasureOutcomeRow[]> {
    // E13 PR-2: when excludeScale is set, drop the population-scale tenant's rows IN SQL (its subject
    // ids are mhn-prefixed) so the per-measure analytics never fetch the 120k rows into app memory.
    const alias = opts?.successfulPopulationOnly ? "o." : "";
    const scaleClause = opts?.excludeScale ? ` AND ${alias}subject_id NOT LIKE 'mhn|%'` : "";
    const source = opts?.successfulPopulationOnly
      ? `${T} o
           JOIN ${SPIKE_SCHEMA}.runs r ON r.id = o.run_id
          WHERE o.measure_id = $1
            AND UPPER(r.status) IN ('COMPLETED', 'PARTIAL_FAILURE')
            AND UPPER(r.scope_type) IN ('MEASURE', 'ALL_PROGRAMS')`
      : `${T} WHERE measure_id = $1`;
    const { rows } = await this.pool.query<{
      subject_id: string;
      status: string;
      evaluation_period: string;
      evaluated_at: Date | string;
      evidence_json: unknown;
      out_of_population: boolean | null;
    }>(
      `SELECT ${alias}subject_id, ${alias}status, ${alias}evaluation_period, ${alias}evaluated_at, ${alias}evidence_json, ${alias}out_of_population
         FROM ${source}${scaleClause} ORDER BY ${alias}evaluated_at ASC${alias ? ", o.id ASC" : ""}`,
      [measureId],
    );
    return rows.map((r) => ({
      subjectId: r.subject_id,
      status: r.status,
      evaluationPeriod: r.evaluation_period,
      evaluatedAt: r.evaluated_at instanceof Date ? r.evaluated_at.toISOString() : r.evaluated_at,
      evidence: r.evidence_json,
      outOfPopulation: flagOf(r.out_of_population),
    }));
  }

  async listOutcomesWithRun(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]> {
    // Measure + day-granular run-period filter pushed into SQL (bounded scan). The run's started day is
    // taken in UTC (`AT TIME ZONE 'UTC'`) so the boundary matches the SQLite floor's UTC substring and is
    // independent of the DB session timezone — a session-local `::date` could shift a boundary run by a
    // day on a non-UTC connection (Fable L8). The casts keep a null bind from constraining the predicate.
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.measureId) where.push(`o.measure_id = $${binds.push(filter.measureId)}`);
    if (filter.from) where.push(`(r.started_at AT TIME ZONE 'UTC')::date >= $${binds.push(filter.from)}::date`);
    if (filter.to) where.push(`(r.started_at AT TIME ZONE 'UTC')::date <= $${binds.push(filter.to)}::date`);
    // E13 PR-2 (excludeScale, mhn ~120k rows) + Fable M16 (excludeTrendHistory) — both exclude runs by
    // `triggered_by`. Constrain `o.run_id` to the qualifying run set (a subquery over the tiny runs
    // table) rather than filtering the joined `r.triggered_by`: a predicate on the joined table can't
    // prune the outcomes scan, so the planner seq-scans all ~1.7M rows to drop the excluded ones. The
    // `run_id = ANY(<qualifying ids>)` form drives the run_id index instead — a bitmap index scan of
    // just the live rows (perf #233: ~3.2s → ~40ms on the live stack; identical result set — a NULL
    // triggered_by is excluded either way).
    const excludedTriggers: string[] = [];
    if (filter.excludeScale) excludedTriggers.push("seed:scale");
    if (filter.excludeTrendHistory) excludedTriggers.push("seed:trend-history");
    if (excludedTriggers.length) {
      const ph = excludedTriggers.map((v) => `$${binds.push(v)}`).join(", ");
      where.push(`o.run_id = ANY (ARRAY(SELECT id FROM ${SPIKE_SCHEMA}.runs WHERE triggered_by NOT IN (${ph})))`);
    }
    if (filter.runIds) {
      // The explicit run set (the winners `listLatestPopulationRuns` resolved). A native UUID column:
      // a malformed id can never match, so drop it here rather than let Postgres throw on the cast;
      // an empty set matches nothing, which the `= ANY('{}')` form already guarantees.
      const ids = filter.runIds.filter(isUuid);
      if (ids.length === 0) return [];
      where.push(`o.run_id = ANY($${binds.push(ids)}::uuid[])`);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const { rows } = await this.pool.query<{
      run_id: string;
      run_started_at: Date | string;
      run_scope_type: string;
      run_status: string;
      run_triggered_by: string | null;
      subject_id: string;
      measure_id: string;
      status: string;
      out_of_population: boolean | null;
    }>(
      `SELECT o.run_id, r.started_at AS run_started_at, r.scope_type AS run_scope_type, r.status AS run_status, r.triggered_by AS run_triggered_by, o.subject_id, o.measure_id, o.status, o.out_of_population
         FROM ${SPIKE_SCHEMA}.outcomes o JOIN ${SPIKE_SCHEMA}.runs r ON r.id = o.run_id${clause}`,
      binds,
    );
    return rows.map((r) => ({
      runId: r.run_id,
      runStartedAt: r.run_started_at instanceof Date ? r.run_started_at.toISOString() : r.run_started_at,
      runScopeType: r.run_scope_type,
      runStatus: r.run_status,
      runTriggeredBy: r.run_triggered_by ?? "manual",
      subjectId: r.subject_id,
      measureId: r.measure_id,
      status: r.status,
      outOfPopulation: flagOf(r.out_of_population),
    }));
  }

  async listLatestPopulationOutcomes(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]> {
    // perf #233 residual: reduce "latest terminal population run per measure" IN SQL instead of
    // shipping every population run's rows across history and reducing in JS (`latestRunRows`). A
    // `DISTINCT ON (measure_id) … ORDER BY started_at DESC, run_id DESC` inner query resolves each
    // measure's winning (measure, run) pair (O(measures) rows), then the outer join fetches only that
    // run's outcomes for that measure. The excludeScale/excludeTrendHistory exclusion uses the same
    // `run_id = ANY(<qualifying ids>)` index form as listOutcomesWithRun; the completed/population
    // predicates mirror the JS `isCompletedRun`/`isPopulationRun` (both case-insensitive — the Java
    // era persisted some scope/status values lowercase).
    const inner: string[] = [
      // Mirrors `POPULATION_SCOPES` (rollup-shared.ts): an allowlist of whole-roster scopes, so a newer
      // COMPLETED SITE run never becomes "the roster" (ADR-077 d4).
      "UPPER(r2.scope_type) IN ('MEASURE','ALL_PROGRAMS')",
      "UPPER(r2.status) IN ('COMPLETED','PARTIAL_FAILURE')",
    ];
    const binds: unknown[] = [];
    if (filter.measureId) inner.push(`o2.measure_id = $${binds.push(filter.measureId)}`);
    if (filter.from) inner.push(`(r2.started_at AT TIME ZONE 'UTC')::date >= $${binds.push(filter.from)}::date`);
    if (filter.to) inner.push(`(r2.started_at AT TIME ZONE 'UTC')::date <= $${binds.push(filter.to)}::date`);
    const excludedTriggers: string[] = [];
    if (filter.excludeScale) excludedTriggers.push("seed:scale");
    if (filter.excludeTrendHistory) excludedTriggers.push("seed:trend-history");
    if (excludedTriggers.length) {
      const ph = excludedTriggers.map((v) => `$${binds.push(v)}`).join(", ");
      inner.push(`o2.run_id = ANY (ARRAY(SELECT id FROM ${SPIKE_SCHEMA}.runs WHERE triggered_by NOT IN (${ph})))`);
    }
    const { rows } = await this.pool.query<{
      run_id: string;
      run_started_at: Date | string;
      run_scope_type: string;
      run_status: string;
      run_triggered_by: string | null;
      subject_id: string;
      measure_id: string;
      status: string;
      out_of_population: boolean | null;
    }>(
      `SELECT o.run_id, r.started_at AS run_started_at, r.scope_type AS run_scope_type, r.status AS run_status, r.triggered_by AS run_triggered_by, o.subject_id, o.measure_id, o.status, o.out_of_population
         FROM ${SPIKE_SCHEMA}.outcomes o
         JOIN ${SPIKE_SCHEMA}.runs r ON r.id = o.run_id
         JOIN (
           SELECT DISTINCT ON (o2.measure_id) o2.measure_id AS measure_id, o2.run_id AS run_id
             FROM ${SPIKE_SCHEMA}.outcomes o2
             JOIN ${SPIKE_SCHEMA}.runs r2 ON r2.id = o2.run_id
            WHERE ${inner.join(" AND ")}
            ORDER BY o2.measure_id, r2.started_at DESC, o2.run_id DESC
         ) latest ON latest.measure_id = o.measure_id AND latest.run_id = o.run_id`,
      binds,
    );
    return rows.map((r) => ({
      runId: r.run_id,
      runStartedAt: r.run_started_at instanceof Date ? r.run_started_at.toISOString() : r.run_started_at,
      runScopeType: r.run_scope_type,
      runStatus: r.run_status,
      runTriggeredBy: r.run_triggered_by ?? "manual",
      subjectId: r.subject_id,
      measureId: r.measure_id,
      status: r.status,
      outOfPopulation: flagOf(r.out_of_population),
    }));
  }

  async listLatestPopulationRuns(measureIds: readonly string[], filter: OutcomeMeasureFilter, perMeasure = 1): Promise<LatestPopulationRun[]> {
    const wanted = [...new Set(measureIds)];
    const per = Number.isFinite(perMeasure) ? Math.max(1, Math.trunc(perMeasure)) : 1;
    if (wanted.length === 0) return [];
    // The run predicates are listLatestPopulationOutcomes' inner query verbatim (scope allowlist,
    // terminal status, the UTC started-day window, the trigger exclusions), so the two methods can only
    // disagree on which run wins if a run holds no row for the measure — which is what the probe checks.
    // `triggered_by NOT IN (...)` is what the sibling reads apply; a NULL triggered_by is excluded there
    // too (NULL NOT IN (...) is not true), so the same run set qualifies here.
    const runWhere: string[] = ["UPPER(r.scope_type) IN ('MEASURE','ALL_PROGRAMS')", "UPPER(r.status) IN ('COMPLETED','PARTIAL_FAILURE')"];
    const binds: unknown[] = [];
    if (filter.from) runWhere.push(`(r.started_at AT TIME ZONE 'UTC')::date >= $${binds.push(filter.from)}::date`);
    if (filter.to) runWhere.push(`(r.started_at AT TIME ZONE 'UTC')::date <= $${binds.push(filter.to)}::date`);
    const excludedTriggers: string[] = [];
    if (filter.excludeScale) excludedTriggers.push("seed:scale");
    if (filter.excludeTrendHistory) excludedTriggers.push("seed:trend-history");
    if (excludedTriggers.length) {
      const ph = excludedTriggers.map((v) => `$${binds.push(v)}`).join(", ");
      runWhere.push(`r.triggered_by NOT IN (${ph})`);
    }
    type RunRow = { id: string; started_at: Date | string; scope_type: string; status: string; triggered_by: string | null };
    const toWinner = (measureId: string, run: RunRow): LatestPopulationRun => ({
      measureId,
      runId: run.id,
      runStartedAt: run.started_at instanceof Date ? run.started_at.toISOString() : run.started_at,
      runScopeType: run.scope_type,
      runStatus: run.status,
      runTriggeredBy: run.triggered_by ?? "manual",
    });

    // 1) The newest PROBE_BUDGET qualifying runs — the runs table, not the outcomes table. Walk them
    //    newest-first and ask each which of the still-unsatisfied measures it holds a row for: one
    //    EXISTS probe per (run, measure) inside ONE query per run, stopping as soon as every measure has
    //    its `per` winners. The common case (the newest ALL_PROGRAMS run holds every routed measure) is
    //    one probe. A negative probe walks the run's index entries (no (run_id, measure_id) index), so
    //    the walk is bounded: a measure the budget cannot settle — routed today and not yet run, or
    //    last evaluated further back than the budget — is resolved by step 2 instead.
    const { rows: runs } = await this.pool.query<RunRow>(
      `SELECT r.id, r.started_at, r.scope_type, r.status, r.triggered_by
         FROM ${SPIKE_SCHEMA}.runs r WHERE ${runWhere.join(" AND ")}
        ORDER BY r.started_at DESC, r.id DESC LIMIT ${LATEST_RUN_PROBE_BUDGET}`,
      binds,
    );
    const remaining = new Map<string, number>(wanted.map((m) => [m, per]));
    const out: LatestPopulationRun[] = [];
    for (const run of runs) {
      if (remaining.size === 0) break;
      const { rows: hits } = await this.pool.query<{ measure_id: string }>(
        `SELECT m.measure_id FROM unnest($2::text[]) AS m(measure_id)
          WHERE EXISTS (SELECT 1 FROM ${SPIKE_SCHEMA}.outcomes o WHERE o.run_id = $1 AND o.measure_id = m.measure_id)`,
        [run.id, [...remaining.keys()]],
      );
      for (const hit of hits) {
        const left = remaining.get(hit.measure_id);
        if (left === undefined) continue;
        out.push(toWinner(hit.measure_id, run));
        if (left <= 1) remaining.delete(hit.measure_id);
        else remaining.set(hit.measure_id, left - 1);
      }
    }
    if (remaining.size === 0 || runs.length < LATEST_RUN_PROBE_BUDGET) return out;

    // 2) The leftovers, each by ONE bounded query over its own index entries: the distinct (measure,
    //    run) pairs of that measure, ranked newest-first under the same run predicates — the
    //    reduction listLatestPopulationOutcomes performs, restricted to the measures the walk could not
    //    settle. `rn` continues past what the walk already found so the window stays exact.
    const leftover = [...remaining.keys()];
    const lbinds: unknown[] = [...binds, leftover, per];
    const { rows: ranked } = await this.pool.query<RunRow & { measure_id: string; rn: string }>(
      `SELECT * FROM (
         SELECT d.measure_id, r.id, r.started_at, r.scope_type, r.status, r.triggered_by,
                ROW_NUMBER() OVER (PARTITION BY d.measure_id ORDER BY r.started_at DESC, r.id DESC) AS rn
           FROM (SELECT DISTINCT o.measure_id, o.run_id FROM ${SPIKE_SCHEMA}.outcomes o WHERE o.measure_id = ANY($${binds.length + 1}::text[])) d
           JOIN ${SPIKE_SCHEMA}.runs r ON r.id = d.run_id
          WHERE ${runWhere.join(" AND ")}
       ) x WHERE rn <= $${binds.length + 2}::int ORDER BY measure_id, rn`,
      lbinds,
    );
    for (const row of ranked) {
      const left = remaining.get(row.measure_id);
      if (left === undefined) continue;
      // The walk already banked (per - left) newest winners for this measure; skip those ranks.
      if (Number(row.rn) <= per - left) continue;
      out.push(toWinner(row.measure_id, row));
    }
    return out;
  }

  async aggregateScaleRun(runId: string): Promise<ScaleGroupCount[]> {
    if (!isUuid(runId)) return []; // guard like the sibling reads (avoid invalid-uuid-syntax errors)
    const cached = this.scaleCache.get(runId);
    if (cached) return cached;
    // Single GROUP BY over the encoded subject_id (`mhn|Lxx|Pxx|n`) — returns
    // O(locations×providers×statuses) rows, never the 120k per-subject rows.
    const { rows } = await this.pool.query<{ location_id: string; provider_id: string; status: string; count: string }>(
      `SELECT split_part(subject_id, '|', 2) AS location_id,
              split_part(subject_id, '|', 3) AS provider_id,
              status, COUNT(*)::text AS count
         FROM ${SPIKE_SCHEMA}.outcomes
        WHERE run_id = $1 AND subject_id LIKE 'mhn|%'
        GROUP BY 1, 2, 3`,
      [runId],
    );
    const groups = rows.map((r) => ({ locationId: r.location_id, providerId: r.provider_id, status: r.status, count: Number(r.count) }));
    // Cache only non-empty results: a not-yet-seeded runId returns [] (cheap to recompute) and must
    // not be pinned to empty if it later becomes a real scale run.
    if (groups.length) this.scaleCache.set(runId, groups);
    return groups;
  }

  async countOutcomesByStatus(runId: string): Promise<OutcomeStatusCount[]> {
    if (!isUuid(runId)) return [];
    // Bounded GROUP BY status (+ MAX evaluated_at) — the run list/summary read models use this instead
    // of materializing every outcome row per run (O(120k) for seed:scale runs; pushed ?limit=20 past
    // the 60s gateway timeout). Same discipline as aggregateScaleRun.
    const { rows } = await this.pool.query<{ status: string; out_of_population: boolean | null; count: string; latest: Date | string | null }>(
      `SELECT status, out_of_population, COUNT(*)::text AS count, MAX(evaluated_at) AS latest
         FROM ${T} WHERE run_id = $1 GROUP BY status, out_of_population`,
      [runId],
    );
    return rows.map((r) => ({
      status: r.status,
      count: Number(r.count),
      latestEvaluatedAt: r.latest == null ? null : r.latest instanceof Date ? r.latest.toISOString() : r.latest,
      outOfPopulation: flagOf(r.out_of_population),
    }));
  }
}
