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
import type { CreateRunInput, RunLogRow, RunRecord, RunStore, RunStatus } from "../run-store.ts";

interface RunRow {
  id: string;
  status: string;
  scope_type: string;
  scope_id: string | null;
  requested_scope_json: string | null;
  started_at: string;
  completed_at: string | null;
}

/** A run's site lives in the requested scope (set by the scoped-run pipeline). */
const siteOf = (requestedScopeJson: string | null): string | null => {
  if (!requestedScopeJson) return null;
  try {
    const site = (JSON.parse(requestedScopeJson) as { site?: unknown }).site;
    return typeof site === "string" && site ? site : null;
  } catch {
    return null;
  }
};

const toRecord = (r: RunRow): RunRecord => ({
  id: r.id,
  status: r.status as RunStatus,
  scopeType: r.scope_type as CreateRunInput["scopeType"],
  scopeId: r.scope_id,
  site: siteOf(r.requested_scope_json),
  startedAt: r.started_at,
  completedAt: r.completed_at,
});

const RUN_COLS = "id, status, scope_type, scope_id, requested_scope_json, started_at, completed_at";

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
    const row = await this.db.prepare(`SELECT ${RUN_COLS} FROM runs WHERE id = ?`).bind(id).first<RunRow>();
    return row ? toRecord(row) : null;
  }

  async listRuns(limit = 100): Promise<RunRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${RUN_COLS} FROM runs ORDER BY started_at DESC, id DESC LIMIT ?`)
      .bind(limit)
      .all<RunRow>();
    return (results ?? []).map(toRecord);
  }

  async appendLog(runId: string, level: string, message: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO run_logs (run_id, ts, level, message) VALUES (?, ?, ?, ?)`)
      .bind(runId, new Date().toISOString(), level, message)
      .run();
  }

  async listLogs(runId: string, limit?: number): Promise<RunLogRow[]> {
    const sql = `SELECT ts, level, message FROM run_logs WHERE run_id = ? ORDER BY id ASC${limit != null ? " LIMIT ?" : ""}`;
    const stmt = this.db.prepare(sql);
    const { results } = await (limit != null ? stmt.bind(runId, limit) : stmt.bind(runId)).all<RunLogRow>();
    return results ?? [];
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
        RETURNING ${RUN_COLS}`,
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
