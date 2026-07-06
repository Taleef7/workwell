/**
 * SQLite/D1 floor implementation of the `OutcomeStore` contract (#104).
 * `evidence` is stored as a JSON TEXT column on the floor (JSONB on the Postgres
 * ceiling). Raw D1 to stay close to the contract for the slice.
 */
import type { CloudDatabase } from "@mieweb/cloud";
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
  evidence_json: string;
  evaluated_at: string;
}

const toRecord = (r: OutcomeRow): OutcomeRecord => ({
  id: r.id,
  runId: r.run_id,
  subjectId: r.subject_id,
  measureId: r.measure_id,
  evaluationPeriod: r.evaluation_period,
  status: r.status,
  evidence: JSON.parse(r.evidence_json),
  evaluatedAt: r.evaluated_at,
});

export class SqliteOutcomeStore implements OutcomeStore {
  constructor(private readonly db: CloudDatabase) {}

  /**
   * In-process memo of `aggregateScaleRun` (perf #233). A COMPLETED `seed:scale` run is written once
   * and never re-evaluated, so its (location, provider, status) aggregation is a pure function of an
   * immutable runId — cached so the hierarchy/programs reads don't repeat a 120k-row GROUP BY per
   * request. Bounded by the number of distinct COMPLETED scale runs ever queried (~one per runnable
   * measure; grows only on a re-seed, which mints new runIds). The store is a long-lived singleton
   * (one per env, see stores/factory.ts), so the cache persists across requests.
   */
  private readonly scaleCache = new Map<string, ScaleGroupCount[]>();

  async recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord> {
    const id = crypto.randomUUID();
    const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
    const evaluationPeriod = input.evaluationPeriod ?? "";
    await this.db
      .prepare(
        `INSERT INTO outcomes (id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.runId, input.subjectId, input.measureId, evaluationPeriod, input.status, JSON.stringify(input.evidence ?? {}), evaluatedAt)
      .run();
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
    // D1 runs a batch atomically (single transaction). `RETURNING id` is required for the batch
    // path (cloud-local executes batched statements via `.all()`, which throws on a non-returning
    // statement — same reason the case-event store appends `RETURNING id`).
    const stmts = inputs.map((input) =>
      this.db
        .prepare(
          `INSERT INTO outcomes (id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(
          crypto.randomUUID(),
          input.runId,
          input.subjectId,
          input.measureId,
          input.evaluationPeriod ?? "",
          input.status,
          JSON.stringify(input.evidence ?? {}),
          input.evaluatedAt ?? new Date().toISOString(),
        ),
    );
    await this.db.batch(stmts);
  }

  async listOutcomes(runId: string, opts?: { limit?: number; offset?: number }): Promise<OutcomeRecord[]> {
    // Optional LIMIT/OFFSET paging (Fable H4); the id tiebreak keeps paging deterministic when many
    // rows share an evaluated_at. SQLite requires a LIMIT before OFFSET, so emit -1 (all) when only an
    // offset is given.
    const binds: unknown[] = [runId];
    let page = "";
    if (opts?.limit != null || opts?.offset != null) {
      page += ` LIMIT ?`;
      binds.push(opts?.limit != null ? Math.max(0, opts.limit) : -1);
      if (opts?.offset != null) {
        page += ` OFFSET ?`;
        binds.push(Math.max(0, opts.offset));
      }
    }
    const { results } = await this.db
      .prepare(
        `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
           FROM outcomes WHERE run_id = ? ORDER BY evaluated_at ASC, id ASC${page}`,
      )
      .bind(...binds)
      .all<OutcomeRow>();
    return (results ?? []).map(toRecord);
  }

  async distinctMeasuresForRun(runId: string, limit = 2): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT DISTINCT measure_id FROM outcomes WHERE run_id = ? LIMIT ?`)
      .bind(runId, Math.max(1, limit))
      .all<{ measure_id: string }>();
    return (results ?? []).map((r) => r.measure_id);
  }

  async getOutcomeById(id: string): Promise<OutcomeRecord | null> {
    const { results } = await this.db
      .prepare(
        `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
           FROM outcomes WHERE id = ?`,
      )
      .bind(id)
      .all<OutcomeRow>();
    const row = (results ?? [])[0];
    return row ? toRecord(row) : null;
  }

  async listOutcomesForEmployee(subjectId: string, limit: number): Promise<EmployeeOutcomeRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT measure_id, status, evaluation_period, evaluated_at, evidence_json
           FROM outcomes WHERE subject_id = ? ORDER BY evaluated_at DESC LIMIT ?`,
      )
      .bind(subjectId, Math.max(1, limit))
      .all<{ measure_id: string; status: string; evaluation_period: string; evaluated_at: string; evidence_json: string }>();
    return (results ?? []).map((r) => ({
      measureId: r.measure_id,
      status: r.status,
      evaluationPeriod: r.evaluation_period,
      evaluatedAt: r.evaluated_at,
      evidence: JSON.parse(r.evidence_json),
    }));
  }

  async listOutcomesForMeasure(measureId: string, opts?: MeasureScanOptions): Promise<MeasureOutcomeRow[]> {
    // E13 PR-2: excludeScale drops the population-scale tenant's (mhn-prefixed) rows in SQL.
    const scaleClause = opts?.excludeScale ? ` AND subject_id NOT LIKE 'mhn|%'` : "";
    const { results } = await this.db
      .prepare(
        `SELECT subject_id, status, evaluation_period, evaluated_at, evidence_json
           FROM outcomes WHERE measure_id = ?${scaleClause} ORDER BY evaluated_at ASC`,
      )
      .bind(measureId)
      .all<{ subject_id: string; status: string; evaluation_period: string; evaluated_at: string; evidence_json: string }>();
    return (results ?? []).map((r) => ({
      subjectId: r.subject_id,
      status: r.status,
      evaluationPeriod: r.evaluation_period,
      evaluatedAt: r.evaluated_at,
      evidence: JSON.parse(r.evidence_json),
    }));
  }

  async listOutcomesWithRun(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]> {
    // Join outcomes→runs and filter by measure + day-granular run period in SQL so the scan
    // is bounded to the selected measure/range (not all run history). substr(started_at,1,10)
    // is the run's started day (started_at is TEXT ISO on the floor).
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.measureId) (where.push("o.measure_id = ?"), binds.push(filter.measureId));
    if (filter.from) (where.push("substr(r.started_at, 1, 10) >= ?"), binds.push(filter.from));
    if (filter.to) (where.push("substr(r.started_at, 1, 10) <= ?"), binds.push(filter.to));
    // E13 PR-2 (excludeScale, mhn ~120k rows) + Fable M16 (excludeTrendHistory) — both exclude runs by
    // `triggered_by`. Constrain `o.run_id` to the qualifying run set (a subquery over the tiny runs
    // table) instead of filtering the joined `r.triggered_by`: on the Pg ceiling this is what lets the
    // planner use the run_id index instead of seq-scanning every outcome row to drop the excluded ones
    // (perf #233). Same result set as the old `<>` chain (a NULL triggered_by is excluded either way).
    const excludedTriggers: string[] = [];
    if (filter.excludeScale) excludedTriggers.push("seed:scale");
    if (filter.excludeTrendHistory) excludedTriggers.push("seed:trend-history");
    if (excludedTriggers.length) {
      where.push(`o.run_id IN (SELECT id FROM runs WHERE triggered_by NOT IN (${excludedTriggers.map(() => "?").join(", ")}))`);
      binds.push(...excludedTriggers);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const { results } = await this.db
      .prepare(
        `SELECT o.run_id, r.started_at AS run_started_at, r.scope_type AS run_scope_type, r.status AS run_status, r.triggered_by AS run_triggered_by, o.subject_id, o.measure_id, o.status
           FROM outcomes o JOIN runs r ON r.id = o.run_id${clause}`,
      )
      .bind(...binds)
      .all<{ run_id: string; run_started_at: string; run_scope_type: string; run_status: string; run_triggered_by: string | null; subject_id: string; measure_id: string; status: string }>();
    return (results ?? []).map((r) => ({
      runId: r.run_id,
      runStartedAt: r.run_started_at,
      runScopeType: r.run_scope_type,
      runStatus: r.run_status,
      runTriggeredBy: r.run_triggered_by ?? "manual",
      subjectId: r.subject_id,
      measureId: r.measure_id,
      status: r.status,
    }));
  }

  async listLatestPopulationOutcomes(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]> {
    // Floor mirror of the Pg ceiling (perf #233 residual). SQLite has no DISTINCT ON, so a
    // ROW_NUMBER() window (SQLite ≥ 3.25) partitions the qualifying (measure, run) pairs by measure,
    // newest run first (started_at DESC, run_id DESC), and rn = 1 selects each measure's winning run;
    // the outer join then fetches only that run's outcomes for that measure. Same completed/population
    // (case-insensitive) + measure/date/exclude predicates as the ceiling, so the two stores return
    // the same result set (asserted by the store contract).
    const inner: string[] = [
      "UPPER(r2.scope_type) NOT IN ('CASE','EMPLOYEE')",
      "UPPER(r2.status) IN ('COMPLETED','PARTIAL_FAILURE')",
    ];
    const binds: unknown[] = [];
    if (filter.measureId) (inner.push("o2.measure_id = ?"), binds.push(filter.measureId));
    if (filter.from) (inner.push("substr(r2.started_at, 1, 10) >= ?"), binds.push(filter.from));
    if (filter.to) (inner.push("substr(r2.started_at, 1, 10) <= ?"), binds.push(filter.to));
    const excludedTriggers: string[] = [];
    if (filter.excludeScale) excludedTriggers.push("seed:scale");
    if (filter.excludeTrendHistory) excludedTriggers.push("seed:trend-history");
    if (excludedTriggers.length) {
      inner.push(`o2.run_id IN (SELECT id FROM runs WHERE triggered_by NOT IN (${excludedTriggers.map(() => "?").join(", ")}))`);
      binds.push(...excludedTriggers);
    }
    const { results } = await this.db
      .prepare(
        `SELECT o.run_id, r.started_at AS run_started_at, r.scope_type AS run_scope_type, r.status AS run_status, r.triggered_by AS run_triggered_by, o.subject_id, o.measure_id, o.status
           FROM outcomes o
           JOIN runs r ON r.id = o.run_id
           JOIN (
             SELECT measure_id, run_id FROM (
               SELECT o2.measure_id AS measure_id, o2.run_id AS run_id,
                      ROW_NUMBER() OVER (PARTITION BY o2.measure_id ORDER BY r2.started_at DESC, o2.run_id DESC) AS rn
                 FROM outcomes o2
                 JOIN runs r2 ON r2.id = o2.run_id
                WHERE ${inner.join(" AND ")}
             ) ranked WHERE rn = 1
           ) latest ON latest.measure_id = o.measure_id AND latest.run_id = o.run_id`,
      )
      .bind(...binds)
      .all<{ run_id: string; run_started_at: string; run_scope_type: string; run_status: string; run_triggered_by: string | null; subject_id: string; measure_id: string; status: string }>();
    return (results ?? []).map((r) => ({
      runId: r.run_id,
      runStartedAt: r.run_started_at,
      runScopeType: r.run_scope_type,
      runStatus: r.run_status,
      runTriggeredBy: r.run_triggered_by ?? "manual",
      subjectId: r.subject_id,
      measureId: r.measure_id,
      status: r.status,
    }));
  }

  async aggregateScaleRun(runId: string): Promise<ScaleGroupCount[]> {
    const cached = this.scaleCache.get(runId);
    if (cached) return cached;
    // Group by (location, provider, status) parsed from the fixed-width encoded subject_id
    // (`mhn|Lxx|Pxx|nnnnnnn`): substr 5..7 = location, 9..11 = provider. The GROUP BY returns
    // O(locations×providers×statuses) rows, never the per-subject rows.
    const { results } = await this.db
      .prepare(
        `SELECT substr(subject_id, 5, 3) AS location_id, substr(subject_id, 9, 3) AS provider_id, status, COUNT(*) AS count
           FROM outcomes WHERE run_id = ? AND subject_id LIKE 'mhn|%'
          GROUP BY location_id, provider_id, status`,
      )
      .bind(runId)
      .all<{ location_id: string; provider_id: string; status: string; count: number }>();
    const groups = (results ?? []).map((r) => ({ locationId: r.location_id, providerId: r.provider_id, status: r.status, count: Number(r.count) }));
    // Cache only non-empty results: an invalid/not-yet-seeded runId returns [] (cheap to recompute)
    // and must not be pinned to empty if it later becomes a real scale run mid-seed.
    if (groups.length) this.scaleCache.set(runId, groups);
    return groups;
  }

  async countOutcomesByStatus(runId: string): Promise<OutcomeStatusCount[]> {
    // Bounded GROUP BY status (+ MAX evaluated_at) — the run list/summary read models use this
    // instead of materializing every outcome row per run (O(120k) for seed:scale runs).
    const { results } = await this.db
      .prepare(
        `SELECT status, COUNT(*) AS count, MAX(evaluated_at) AS latest
           FROM outcomes WHERE run_id = ? GROUP BY status`,
      )
      .bind(runId)
      .all<{ status: string; count: number; latest: string | null }>();
    return (results ?? []).map((r) => ({ status: r.status, count: Number(r.count), latestEvaluatedAt: r.latest ?? null }));
  }
}
