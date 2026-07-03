/**
 * Postgres-ceiling implementation of the `RunStore` contract (#104).
 *
 * Same contract as the SQLite floor (`../sqlite/run-store-sqlite.ts`), different
 * concurrency primitive: the atomic queue-claim uses `SELECT … FOR UPDATE SKIP
 * LOCKED` inside a transaction (the performance ceiling) where the floor uses
 * `UPDATE … RETURNING`. SKIP LOCKED lets N workers claim N distinct runs in
 * parallel without blocking each other — the property the floor can't offer.
 *
 * Tables are fully schema-qualified (`workwell_spike.*`) because the canonical
 * `public` schema has same-named tables; we must never touch those.
 */
import { isUuid, type PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { CreateRunInput, RunLogRow, RunRecord, RunStore, RunStatus } from "../run-store.ts";
import { STUCK_RUN_THRESHOLD_MS } from "../run-store.ts";

interface RunRow {
  id: string;
  status: string;
  scope_type: string;
  scope_id: string | null;
  triggered_by: string | null;
  requested_scope_json: unknown; // JSONB → already parsed by pg
  measurement_period_start: Date | string;
  measurement_period_end: Date | string;
  started_at: Date | string;
  completed_at: Date | string | null;
}

const iso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

/** JSONB is already parsed by pg; normalize null/non-object to {}. */
const asScope = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const siteOf = (scope: Record<string, unknown>): string | null =>
  typeof scope.site === "string" && scope.site ? scope.site : null;

const toRecord = (r: RunRow): RunRecord => {
  const requestedScope = asScope(r.requested_scope_json);
  return {
    id: r.id,
    status: r.status as RunStatus,
    scopeType: r.scope_type as CreateRunInput["scopeType"],
    scopeId: r.scope_id,
    triggeredBy: r.triggered_by ?? "manual",
    site: siteOf(requestedScope),
    requestedScope,
    startedAt: iso(r.started_at)!,
    completedAt: iso(r.completed_at),
    measurementPeriodStart: iso(r.measurement_period_start)!,
    measurementPeriodEnd: iso(r.measurement_period_end)!,
  };
};

const T = `${SPIKE_SCHEMA}.runs`;
const RUN_COLS = "id, status, scope_type, scope_id, triggered_by, requested_scope_json, measurement_period_start, measurement_period_end, started_at, completed_at";

export class PgRunStore implements RunStore {
  constructor(private readonly pool: PgPool) {}

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = crypto.randomUUID();
    // Optional backdating (synthetic trend history): honor explicit status/started_at/completed_at,
    // else the original defaults (QUEUED, now, null) — existing callers are unchanged.
    const status = input.status ?? "QUEUED";
    const startedAt = input.startedAt ?? new Date().toISOString();
    const completedAt = input.completedAt ?? null;
    const { rows } = await this.pool.query<RunRow>(
      `INSERT INTO ${T}
         (id, status, scope_type, scope_id, triggered_by, requested_scope_json,
          measurement_period_start, measurement_period_end, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       RETURNING ${RUN_COLS}`,
      [
        id,
        status,
        input.scopeType,
        input.scopeId ?? null,
        input.triggeredBy,
        JSON.stringify(input.requestedScope ?? {}),
        input.measurementPeriodStart,
        input.measurementPeriodEnd,
        startedAt,
        completedAt,
      ],
    );
    return toRecord(rows[0]!);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    // Native UUID column: a malformed id finds no row on the floor, so don't let
    // Postgres throw `invalid input syntax for type uuid` — match the contract.
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLS}
         FROM ${T} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listRuns(limit = 100): Promise<RunRecord[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLS}
         FROM ${T} ORDER BY started_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toRecord);
  }

  async getLastRunByTriggeredBy(triggeredBy: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLS}
         FROM ${T} WHERE triggered_by = $1 ORDER BY started_at DESC LIMIT 1`,
      [triggeredBy],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listRunsByTriggeredBy(triggeredBy: string, limit = 500): Promise<RunRecord[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLS}
         FROM ${T} WHERE triggered_by = $1 ORDER BY started_at DESC, id DESC LIMIT $2`,
      [triggeredBy, Math.max(1, limit)],
    );
    return rows.map(toRecord);
  }

  async appendLog(runId: string, level: string, message: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.run_logs (run_id, ts, level, message) VALUES ($1, $2, $3, $4)`,
      [runId, new Date().toISOString(), level, message],
    );
  }

  async listLogs(runId: string, limit?: number): Promise<RunLogRow[]> {
    if (!isUuid(runId)) return [];
    const { rows } = await this.pool.query<{ ts: Date | string; level: string; message: string }>(
      `SELECT ts, level, message FROM ${SPIKE_SCHEMA}.run_logs WHERE run_id = $1 ORDER BY id ASC${limit != null ? " LIMIT $2" : ""}`,
      limit != null ? [runId, limit] : [runId],
    );
    return rows.map((r) => ({ ts: iso(r.ts)!, level: r.level, message: r.message }));
  }

  /**
   * Atomically claim the oldest QUEUED run and flip it to RUNNING using
   * `FOR UPDATE SKIP LOCKED` in a transaction: concurrent workers each lock and
   * claim a *different* row instead of contending for the same one. Returns null
   * when the queue is empty.
   */
  async claimNextQueuedRun(workerId: string): Promise<RunRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const picked = await client.query<{ id: string }>(
        `SELECT id FROM ${T}
          WHERE status = 'QUEUED'
          ORDER BY started_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (!picked.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const { rows } = await client.query<RunRow>(
        `UPDATE ${T}
            SET status = 'RUNNING', claimed_by = $2
          WHERE id = $1
        RETURNING ${RUN_COLS}`,
        [picked.rows[0].id, workerId],
      );
      await client.query("COMMIT");
      return toRecord(rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transition a QUEUED run to RUNNING so it leaves the claim path (idempotent:
   * only QUEUED rows move; any later status is untouched). Returns the current row.
   */
  async markRunning(runId: string): Promise<RunRecord | null> {
    if (!isUuid(runId)) return null;
    await this.pool.query(
      `UPDATE ${T} SET status = 'RUNNING' WHERE id = $1 AND status = 'QUEUED'`,
      [runId],
    );
    return this.getRun(runId);
  }

  async finalizeRun(runId: string, status: RunStatus): Promise<RunRecord | null> {
    if (!isUuid(runId)) return null;
    await this.pool.query(`UPDATE ${T} SET status = $2, completed_at = $3 WHERE id = $1`, [
      runId,
      status,
      new Date().toISOString(),
    ]);
    return this.getRun(runId);
  }

  async failStuckRuns(olderThanMs = STUCK_RUN_THRESHOLD_MS): Promise<string[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    // Target only UNCLAIMED RUNNING runs — i.e. the in-process ctx.waitUntil orphans. `markRunning`
    // (the async-run path) leaves claimed_by NULL, whereas claimNextQueuedRun stamps claimed_by, so
    // a legitimately CLAIMED worker job (even one processing past the threshold) is NOT recovered.
    // QUEUED is also excluded — that is the claim path's "waiting for a worker" state, not an orphan.
    const stuck = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${T} WHERE status = 'RUNNING' AND claimed_by IS NULL AND started_at < $1`,
      [cutoff],
    );
    if (stuck.rows.length === 0) return [];
    await this.pool.query(
      `UPDATE ${T} SET status = 'FAILED', completed_at = $1 WHERE status = 'RUNNING' AND claimed_by IS NULL AND started_at < $2`,
      [new Date().toISOString(), cutoff],
    );
    return stuck.rows.map((r) => r.id);
  }
}
