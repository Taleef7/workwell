/**
 * Storage contract example — `RunStore` (issue #96, companion memo §5).
 *
 * Application code calls explicit repository contracts; it never sees SQL or a
 * concrete driver. Each backend adapter implements these methods its own way:
 *
 *   - Postgres  : claimNextQueuedRun → SELECT … FOR UPDATE SKIP LOCKED
 *   - SQLite/D1 : claimNextQueuedRun → UPDATE … RETURNING (the portable floor)
 *
 * "SQLite/D1 define the portable floor; Postgres provides the performance
 * ceiling." Drizzle/Kysely handle schema/migrations/CRUD; the hard bits
 * (locking, queue-claim, JSON-heavy reads) stay in adapter-specific code — the
 * ORM is NOT the portability layer.
 *
 * This file is the contract only. The SQLite-floor and Postgres adapters that
 * implement it land in Phase 2 (#104); the full set of stores
 * (RunStore/CaseStore/OutcomeStore/MeasureStore/AuditStore) follows the same
 * shape. Schema/migrations remain Taleef-owned (CLAUDE.md hard rule).
 */

export type RunStatus =
  | "REQUESTED"
  | "QUEUED"
  | "RUNNING"
  | "PARTIAL_FAILURE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface CreateRunInput {
  scopeType: "ALL_PROGRAMS" | "MEASURE" | "SITE" | "EMPLOYEE" | "CASE";
  scopeId?: string;
  triggeredBy: string;
  requestedScope: Record<string, unknown>;
  measurementPeriodStart: string;
  measurementPeriodEnd: string;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  scopeType: CreateRunInput["scopeType"];
  scopeId: string | null;
  /** Site the run targeted, if any (from the requested scope) — drives the `site` list filter. */
  site: string | null;
  /** The original requested scope (measureId / employeeExternalId / site / …) — used to rerun. */
  requestedScope: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
}

export interface RunLogRow {
  ts: string;
  level: string;
  message: string;
}

export interface RunStore {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  /** Runs newest-first (by started_at), capped at `limit` — the /api/runs list read model. */
  listRuns(limit?: number): Promise<RunRecord[]>;
  appendLog(runId: string, level: string, message: string): Promise<void>;
  /** A run's log timeline, oldest-first, capped at `limit` when given. */
  listLogs(runId: string, limit?: number): Promise<RunLogRow[]>;
  /** Atomically claim the next QUEUED run for a worker (locking is adapter-specific). */
  claimNextQueuedRun(workerId: string): Promise<RunRecord | null>;
  /** Move a QUEUED run to RUNNING (no-op if already past QUEUED) so it leaves the claim path. */
  markRunning(runId: string): Promise<RunRecord | null>;
  /** Set a terminal status (COMPLETED/PARTIAL_FAILURE/FAILED) + completed_at. */
  finalizeRun(runId: string, status: RunStatus): Promise<RunRecord | null>;
}
