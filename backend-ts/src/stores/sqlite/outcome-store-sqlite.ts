/**
 * SQLite/D1 floor implementation of the `OutcomeStore` contract (#104).
 * `evidence` is stored as a JSON TEXT column on the floor (JSONB on the Postgres
 * ceiling). Raw D1 to stay close to the contract for the slice.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { OutcomeRecord, OutcomeStore, RecordOutcomeInput } from "../outcome-store.ts";

interface OutcomeRow {
  id: string;
  run_id: string;
  subject_id: string;
  measure_id: string;
  status: string;
  evidence_json: string;
  evaluated_at: string;
}

const toRecord = (r: OutcomeRow): OutcomeRecord => ({
  id: r.id,
  runId: r.run_id,
  subjectId: r.subject_id,
  measureId: r.measure_id,
  status: r.status,
  evidence: JSON.parse(r.evidence_json),
  evaluatedAt: r.evaluated_at,
});

export class SqliteOutcomeStore implements OutcomeStore {
  constructor(private readonly db: CloudDatabase) {}

  async recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord> {
    const id = crypto.randomUUID();
    const evaluatedAt = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO outcomes (id, run_id, subject_id, measure_id, status, evidence_json, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.runId, input.subjectId, input.measureId, input.status, JSON.stringify(input.evidence ?? {}), evaluatedAt)
      .run();
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
    const { results } = await this.db
      .prepare(
        `SELECT id, run_id, subject_id, measure_id, status, evidence_json, evaluated_at
           FROM outcomes WHERE run_id = ? ORDER BY evaluated_at ASC`,
      )
      .bind(runId)
      .all<OutcomeRow>();
    return (results ?? []).map(toRecord);
  }
}
