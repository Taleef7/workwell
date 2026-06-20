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

  async listOutcomes(runId: string): Promise<OutcomeRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
           FROM outcomes WHERE run_id = ? ORDER BY evaluated_at ASC`,
      )
      .bind(runId)
      .all<OutcomeRow>();
    return (results ?? []).map(toRecord);
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

  async listOutcomesForMeasure(measureId: string): Promise<MeasureOutcomeRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT subject_id, status, evaluation_period, evaluated_at, evidence_json
           FROM outcomes WHERE measure_id = ? ORDER BY evaluated_at ASC`,
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
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const { results } = await this.db
      .prepare(
        `SELECT o.run_id, r.started_at AS run_started_at, r.scope_type AS run_scope_type, r.status AS run_status, o.subject_id, o.measure_id, o.status
           FROM outcomes o JOIN runs r ON r.id = o.run_id${clause}`,
      )
      .bind(...binds)
      .all<{ run_id: string; run_started_at: string; run_scope_type: string; run_status: string; subject_id: string; measure_id: string; status: string }>();
    return (results ?? []).map((r) => ({
      runId: r.run_id,
      runStartedAt: r.run_started_at,
      runScopeType: r.run_scope_type,
      runStatus: r.run_status,
      subjectId: r.subject_id,
      measureId: r.measure_id,
      status: r.status,
    }));
  }
}
