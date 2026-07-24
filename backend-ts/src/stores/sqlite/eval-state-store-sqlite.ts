/**
 * SQLite floor adapter for `EvalStateStore` (#263 Phase 2b). `INSERT OR REPLACE` on the UNIQUE
 * (subject_id, measure_id, period) key — last write wins, a fresh `id` each upsert (the id is not
 * referenced elsewhere). A pure cache; descriptive only (ADR-008).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { EvalStateRow, EvalStateStore, UpsertEvalStateInput } from "../eval-state-store.ts";

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
  last_evaluated_at: string;
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
  lastEvaluatedAt: r.last_evaluated_at,
});

const COLS =
  "id, subject_id, measure_id, period, data_hash, logic_version, next_transition_at, last_status, source_outcome_id, source_eval_date, last_evaluated_at";

export class SqliteEvalStateStore implements EvalStateStore {
  constructor(private readonly db: CloudDatabase) {}

  async getEvalState(subjectId: string, measureId: string, period: string): Promise<EvalStateRow | null> {
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM eval_state WHERE subject_id = ? AND measure_id = ? AND period = ?`)
      .bind(subjectId, measureId, period)
      .all<Row>();
    const row = (results ?? [])[0];
    return row ? toRow(row) : null;
  }

  async listEvalStatesForMeasurePeriod(measureId: string, period: string): Promise<EvalStateRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM eval_state WHERE measure_id = ? AND period = ?`)
      .bind(measureId, period)
      .all<Row>();
    return (results ?? []).map(toRow);
  }

  async upsertEvalState(input: UpsertEvalStateInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO eval_state (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      )
      .run();
  }
}
