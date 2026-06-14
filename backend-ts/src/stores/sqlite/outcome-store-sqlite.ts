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
} from "../outcome-store.ts";

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

  async listOutcomesWithRun(filter: OutcomeMeasureFilter): Promise<OutcomeWithRun[]> {
    // Join outcomes→runs and filter by measure + day-granular run period in SQL so the scan
    // is bounded to the selected measure/range (not all run history). substr(started_at,1,10)
    // is the run's started day (started_at is TEXT ISO on the floor).
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.measureId) (where.push("o.measure_id = ?"), binds.push(filter.measureId));
    if (filter.from) (where.push("substr(r.started_at, 1, 10) >= ?"), binds.push(filter.from));
    if (filter.to) (where.push("substr(r.started_at, 1, 10) <= ?"), binds.push(filter.to));
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const { results } = await this.db
      .prepare(
        `SELECT o.run_id, r.started_at AS run_started_at, o.subject_id, o.measure_id, o.status
           FROM outcomes o JOIN runs r ON r.id = o.run_id${clause}`,
      )
      .bind(...binds)
      .all<{ run_id: string; run_started_at: string; subject_id: string; measure_id: string; status: string }>();
    return (results ?? []).map((r) => ({
      runId: r.run_id,
      runStartedAt: r.run_started_at,
      subjectId: r.subject_id,
      measureId: r.measure_id,
      status: r.status,
    }));
  }
}
