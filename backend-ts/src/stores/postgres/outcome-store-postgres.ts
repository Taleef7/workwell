/**
 * Postgres-ceiling implementation of the `OutcomeStore` contract (#104).
 * Same contract as the SQLite floor; `evidence` lives in a native JSONB column
 * (TEXT JSON on the floor). Schema-qualified to avoid the canonical `public.outcomes`.
 */
import { isUuid, type PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type {
  OutcomeRecord,
  OutcomeStore,
  RecordOutcomeInput,
  OutcomeWithRun,
  OutcomeMeasureFilter,
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
}

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
});

const T = `${SPIKE_SCHEMA}.outcomes`;

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
      `INSERT INTO ${T} (id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [id, input.runId, input.subjectId, input.measureId, evaluationPeriod, input.status, JSON.stringify(input.evidence ?? {}), evaluatedAt],
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
    };
  }

  async recordOutcomes(inputs: RecordOutcomeInput[]): Promise<void> {
    if (inputs.length === 0) return;
    // Chunked multi-row INSERT so the trend-history backfill (~100 rows/run × weeks × measures)
    // is a handful of round-trips on Neon, not thousands. 8 columns/row × CHUNK must stay well
    // under Postgres' 65535 bind-parameter cap; 500 rows = 4000 params, comfortably safe.
    const CHUNK = 500;
    const defaultEvaluatedAt = new Date().toISOString();
    for (let start = 0; start < inputs.length; start += CHUNK) {
      const chunk = inputs.slice(start, start + CHUNK);
      const binds: unknown[] = [];
      const tuples = chunk.map((input) => {
        const o = binds.length;
        binds.push(
          crypto.randomUUID(),
          input.runId,
          input.subjectId,
          input.measureId,
          input.evaluationPeriod ?? "",
          input.status,
          JSON.stringify(input.evidence ?? {}),
          input.evaluatedAt ?? defaultEvaluatedAt,
        );
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}::jsonb, $${o + 8})`;
      });
      await this.pool.query(
        `INSERT INTO ${T} (id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at)
         VALUES ${tuples.join(", ")}`,
        binds,
      );
    }
  }

  async listOutcomes(runId: string, opts?: { limit?: number; offset?: number }): Promise<OutcomeRecord[]> {
    // Native UUID column: a malformed run id yields no rows on the floor, so don't
    // let Postgres throw `invalid input syntax for type uuid` — match the contract.
    if (!isUuid(runId)) return [];
    // Optional LIMIT/OFFSET paging (Fable H4) — the id tiebreak makes paging deterministic when many
    // rows share an evaluated_at (all of a run's outcomes are stamped within the same run).
    const binds: unknown[] = [runId];
    let page = "";
    if (opts?.limit != null) page += ` LIMIT $${binds.push(Math.max(0, opts.limit))}`;
    if (opts?.offset != null) page += ` OFFSET $${binds.push(Math.max(0, opts.offset))}`;
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
         FROM ${T} WHERE run_id = $1 ORDER BY evaluated_at ASC, id ASC${page}`,
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
      `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
         FROM ${T} WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listOutcomesForEmployee(subjectId: string, limit: number): Promise<EmployeeOutcomeRow[]> {
    const { rows } = await this.pool.query<{
      measure_id: string;
      status: string;
      evaluation_period: string;
      evaluated_at: Date | string;
      evidence_json: unknown;
    }>(
      `SELECT measure_id, status, evaluation_period, evaluated_at, evidence_json
         FROM ${T} WHERE subject_id = $1 ORDER BY evaluated_at DESC LIMIT $2`,
      [subjectId, Math.max(1, limit)],
    );
    return rows.map((r) => ({
      measureId: r.measure_id,
      status: r.status,
      evaluationPeriod: r.evaluation_period,
      evaluatedAt: r.evaluated_at instanceof Date ? r.evaluated_at.toISOString() : r.evaluated_at,
      evidence: r.evidence_json,
    }));
  }

  async listOutcomesForMeasure(measureId: string, opts?: MeasureScanOptions): Promise<MeasureOutcomeRow[]> {
    // E13 PR-2: when excludeScale is set, drop the population-scale tenant's rows IN SQL (its subject
    // ids are mhn-prefixed) so the per-measure analytics never fetch the 120k rows into app memory.
    const scaleClause = opts?.excludeScale ? ` AND subject_id NOT LIKE 'mhn|%'` : "";
    const { rows } = await this.pool.query<{
      subject_id: string;
      status: string;
      evaluation_period: string;
      evaluated_at: Date | string;
      evidence_json: unknown;
    }>(
      `SELECT subject_id, status, evaluation_period, evaluated_at, evidence_json
         FROM ${T} WHERE measure_id = $1${scaleClause} ORDER BY evaluated_at ASC`,
      [measureId],
    );
    return rows.map((r) => ({
      subjectId: r.subject_id,
      status: r.status,
      evaluationPeriod: r.evaluation_period,
      evaluatedAt: r.evaluated_at instanceof Date ? r.evaluated_at.toISOString() : r.evaluated_at,
      evidence: r.evidence_json,
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
    }>(
      `SELECT o.run_id, r.started_at AS run_started_at, r.scope_type AS run_scope_type, r.status AS run_status, r.triggered_by AS run_triggered_by, o.subject_id, o.measure_id, o.status
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
    }));
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
    const { rows } = await this.pool.query<{ status: string; count: string; latest: Date | string | null }>(
      `SELECT status, COUNT(*)::text AS count, MAX(evaluated_at) AS latest
         FROM ${T} WHERE run_id = $1 GROUP BY status`,
      [runId],
    );
    return rows.map((r) => ({
      status: r.status,
      count: Number(r.count),
      latestEvaluatedAt: r.latest == null ? null : r.latest instanceof Date ? r.latest.toISOString() : r.latest,
    }));
  }
}
