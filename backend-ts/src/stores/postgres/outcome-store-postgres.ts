/**
 * Postgres-ceiling implementation of the `OutcomeStore` contract (#104).
 * Same contract as the SQLite floor; `evidence` lives in a native JSONB column
 * (TEXT JSON on the floor). Schema-qualified to avoid the canonical `public.outcomes`.
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { OutcomeRecord, OutcomeStore, RecordOutcomeInput } from "../outcome-store.ts";

interface OutcomeRow {
  id: string;
  run_id: string;
  subject_id: string;
  measure_id: string;
  status: string;
  evidence_json: unknown;
  evaluated_at: Date | string;
}

const toRecord = (r: OutcomeRow): OutcomeRecord => ({
  id: r.id,
  runId: r.run_id,
  subjectId: r.subject_id,
  measureId: r.measure_id,
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
    await this.pool.query(
      `INSERT INTO ${T} (id, run_id, subject_id, measure_id, status, evidence_json, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, input.runId, input.subjectId, input.measureId, input.status, JSON.stringify(input.evidence ?? {}), evaluatedAt],
    );
    return {
      id,
      runId: input.runId,
      subjectId: input.subjectId,
      measureId: input.measureId,
      status: input.status,
      evidence: input.evidence ?? {},
      evaluatedAt,
    };
  }

  async listOutcomes(runId: string): Promise<OutcomeRecord[]> {
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT id, run_id, subject_id, measure_id, status, evidence_json, evaluated_at
         FROM ${T} WHERE run_id = $1 ORDER BY evaluated_at ASC`,
      [runId],
    );
    return rows.map(toRecord);
  }
}
