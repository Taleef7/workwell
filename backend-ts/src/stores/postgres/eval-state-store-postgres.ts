/**
 * Postgres ceiling adapter for `EvalStateStore` (#263 Phase 2b). Idempotent upsert via ON CONFLICT on
 * the UNIQUE (subject_id, measure_id, period) key DO UPDATE (last write wins). Schema-qualified to
 * workwell_spike. `next_transition_at`/`source_eval_date` are YYYY-MM-DD TEXT (lexicographic =
 * chronological, identical to the SQLite floor). A pure cache; descriptive only (ADR-008).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { EvalStateRow, EvalStateStore, UpsertEvalStateInput } from "../eval-state-store.ts";

const S = SPIKE_SCHEMA;
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

interface Row {
  id: string;
  subject_id: string;
  measure_id: string;
  period: string;
  data_hash: string;
  logic_version: string;
  next_transition_at: string | null;
  last_status: string;
  source_outcome_id: string;
  source_eval_date: string;
  last_evaluated_at: Date | string;
}

const toRow = (r: Row): EvalStateRow => ({
  id: r.id,
  subjectId: r.subject_id,
  measureId: r.measure_id,
  period: r.period,
  dataHash: r.data_hash,
  logicVersion: r.logic_version,
  nextTransitionAt: r.next_transition_at,
  lastStatus: r.last_status,
  sourceOutcomeId: r.source_outcome_id,
  sourceEvalDate: r.source_eval_date,
  lastEvaluatedAt: iso(r.last_evaluated_at),
});

const COLS =
  "id, subject_id, measure_id, period, data_hash, logic_version, next_transition_at, last_status, source_outcome_id, source_eval_date, last_evaluated_at";

export class PgEvalStateStore implements EvalStateStore {
  constructor(private readonly pool: PgPool) {}

  async getEvalState(subjectId: string, measureId: string, period: string): Promise<EvalStateRow | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM ${S}.eval_state WHERE subject_id = $1 AND measure_id = $2 AND period = $3`,
      [subjectId, measureId, period],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async listEvalStatesForMeasurePeriod(measureId: string, period: string): Promise<EvalStateRow[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM ${S}.eval_state WHERE measure_id = $1 AND period = $2`,
      [measureId, period],
    );
    return rows.map(toRow);
  }

  async upsertEvalState(input: UpsertEvalStateInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${S}.eval_state (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (subject_id, measure_id, period)
       DO UPDATE SET data_hash = $5, logic_version = $6, next_transition_at = $7, last_status = $8,
                     source_outcome_id = $9, source_eval_date = $10, last_evaluated_at = $11`,
      [
        crypto.randomUUID(),
        input.subjectId,
        input.measureId,
        input.period,
        input.dataHash,
        input.logicVersion,
        input.nextTransitionAt,
        input.lastStatus,
        input.sourceOutcomeId,
        input.sourceEvalDate,
        input.lastEvaluatedAt,
      ],
    );
  }
}
