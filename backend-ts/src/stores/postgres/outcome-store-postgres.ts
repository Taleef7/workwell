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

  async recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord> {
    const id = crypto.randomUUID();
    const evaluatedAt = new Date().toISOString();
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
    const evaluatedAt = new Date().toISOString();
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
          evaluatedAt,
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

  async listOutcomes(runId: string): Promise<OutcomeRecord[]> {
    // Native UUID column: a malformed run id yields no rows on the floor, so don't
    // let Postgres throw `invalid input syntax for type uuid` — match the contract.
    if (!isUuid(runId)) return [];
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
         FROM ${T} WHERE run_id = $1 ORDER BY evaluated_at ASC`,
      [runId],
    );
    return rows.map(toRecord);
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

  async listOutcomesForMeasure(measureId: string): Promise<MeasureOutcomeRow[]> {
    const { rows } = await this.pool.query<{
      subject_id: string;
      status: string;
      evaluation_period: string;
      evaluated_at: Date | string;
      evidence_json: unknown;
    }>(
      `SELECT subject_id, status, evaluation_period, evaluated_at, evidence_json
         FROM ${T} WHERE measure_id = $1 ORDER BY evaluated_at ASC`,
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
    // Measure + day-granular run-period filter pushed into SQL (bounded scan). started_at::date
    // is the run's started day; the casts keep a null bind from constraining the predicate.
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.measureId) where.push(`o.measure_id = $${binds.push(filter.measureId)}`);
    if (filter.from) where.push(`r.started_at::date >= $${binds.push(filter.from)}::date`);
    if (filter.to) where.push(`r.started_at::date <= $${binds.push(filter.to)}::date`);
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const { rows } = await this.pool.query<{
      run_id: string;
      run_started_at: Date | string;
      run_scope_type: string;
      run_status: string;
      subject_id: string;
      measure_id: string;
      status: string;
    }>(
      `SELECT o.run_id, r.started_at AS run_started_at, r.scope_type AS run_scope_type, r.status AS run_status, o.subject_id, o.measure_id, o.status
         FROM ${SPIKE_SCHEMA}.outcomes o JOIN ${SPIKE_SCHEMA}.runs r ON r.id = o.run_id${clause}`,
      binds,
    );
    return rows.map((r) => ({
      runId: r.run_id,
      runStartedAt: r.run_started_at instanceof Date ? r.run_started_at.toISOString() : r.run_started_at,
      runScopeType: r.run_scope_type,
      runStatus: r.run_status,
      subjectId: r.subject_id,
      measureId: r.measure_id,
      status: r.status,
    }));
  }
}
