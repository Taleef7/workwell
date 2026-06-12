/**
 * SQLite/D1 floor implementation of the `RunStore` contract (#103/#104).
 *
 * Application code calls the contract; this adapter owns the SQL. The hard bit —
 * atomically claiming the next queued run — uses `UPDATE … RETURNING` (the
 * portable floor); the Postgres ceiling adapter will use `FOR UPDATE SKIP LOCKED`.
 * Drizzle/Kysely would handle the plain CRUD; kept as raw D1 here to stay close to
 * the contract for the spike.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { CreateRunInput, RunRecord, RunStore, RunStatus } from "../run-store.ts";

interface RunRow {
  id: string;
  status: string;
  scope_type: string;
  scope_id: string | null;
  started_at: string;
  completed_at: string | null;
}

const toRecord = (r: RunRow): RunRecord => ({
  id: r.id,
  status: r.status as RunStatus,
  scopeType: r.scope_type as CreateRunInput["scopeType"],
  scopeId: r.scope_id,
  startedAt: r.started_at,
  completedAt: r.completed_at,
});

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: CloudDatabase) {}

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO runs
           (id, status, scope_type, scope_id, triggered_by, requested_scope_json,
            measurement_period_start, measurement_period_end, started_at)
         VALUES (?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.scopeType,
        input.scopeId ?? null,
        input.triggeredBy,
        JSON.stringify(input.requestedScope ?? {}),
        input.measurementPeriodStart,
        input.measurementPeriodEnd,
        startedAt,
      )
      .run();
    const created = await this.getRun(id);
    if (!created) throw new Error(`createRun: row ${id} vanished after insert`);
    return created;
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, status, scope_type, scope_id, started_at, completed_at
           FROM runs WHERE id = ?`,
      )
      .bind(id)
      .first<RunRow>();
    return row ? toRecord(row) : null;
  }

  async appendLog(runId: string, level: string, message: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO run_logs (run_id, ts, level, message) VALUES (?, ?, ?, ?)`)
      .bind(runId, new Date().toISOString(), level, message)
      .run();
  }

  /**
   * Atomically claim the oldest QUEUED run for `workerId` and flip it to RUNNING.
   * `UPDATE … RETURNING` is one statement, so two workers cannot claim the same row
   * (SQLite serializes writers). Returns null when the queue is empty.
   */
  async claimNextQueuedRun(workerId: string): Promise<RunRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE runs
            SET status = 'RUNNING', claimed_by = ?
          WHERE id = (
            SELECT id FROM runs WHERE status = 'QUEUED'
            ORDER BY started_at ASC LIMIT 1
          )
        RETURNING id, status, scope_type, scope_id, started_at, completed_at`,
      )
      .bind(workerId)
      .first<RunRow>();
    return row ? toRecord(row) : null;
  }

  /**
   * Transition a QUEUED run to RUNNING so it leaves the claim path (a run being
   * processed must not be re-handed to a worker). Only QUEUED rows move; any later
   * status is left untouched (idempotent). Returns the current row, or null if absent.
   */
  async markRunning(runId: string): Promise<RunRecord | null> {
    await this.db
      .prepare(`UPDATE runs SET status = 'RUNNING' WHERE id = ? AND status = 'QUEUED'`)
      .bind(runId)
      .run();
    return this.getRun(runId);
  }
}
