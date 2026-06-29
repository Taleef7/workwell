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
  /**
   * Optional BACKDATING (synthetic trend-history backfill). When present the adapter persists these
   * instead of the defaults (`started_at = now`, `status = QUEUED`, `completed_at = null`). Columns
   * already exist — no schema change. Used to write COMPLETED runs dated weeks in the past so the
   * programs trend chart has real, varied history.
   */
  startedAt?: string;
  completedAt?: string;
  status?: RunStatus;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  scopeType: CreateRunInput["scopeType"];
  scopeId: string | null;
  /** What triggered the run (`manual` | `rerun` | `seed:trend-history` | …) — drives the run
   *  list's triggerType so synthetic seed runs aren't shown/filtered as MANUAL operator runs. */
  triggeredBy: string;
  /** Site the run targeted, if any (from the requested scope) — drives the `site` list filter. */
  site: string | null;
  /** The original requested scope (measureId / employeeExternalId / site / …) — used to rerun. */
  requestedScope: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
  /** Measurement period the run evaluated against (ISO-8601). */
  measurementPeriodStart: string;
  measurementPeriodEnd: string;
}

export interface RunLogRow {
  ts: string;
  level: string;
  message: string;
}

/**
 * Runs left RUNNING/QUEUED longer than this are treated as orphaned by a restart (see
 * {@link RunStore.failStuckRuns}). Far beyond the longest real run (~5-6 min for ALL_PROGRAMS on
 * the Postgres ceiling), so the boot-time sweep can never fail a legitimately in-flight run.
 */
export const STUCK_RUN_THRESHOLD_MS = 30 * 60 * 1000;

export interface RunStore {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  /** Runs newest-first (by started_at), capped at `limit` — the /api/runs list read model. */
  listRuns(limit?: number): Promise<RunRecord[]>;
  /** Return the single most-recent run with the given `triggered_by` value, or null if none. */
  getLastRunByTriggeredBy(triggeredBy: string): Promise<RunRecord | null>;
  appendLog(runId: string, level: string, message: string): Promise<void>;
  /** A run's log timeline, oldest-first, capped at `limit` when given. */
  listLogs(runId: string, limit?: number): Promise<RunLogRow[]>;
  /** Atomically claim the next QUEUED run for a worker (locking is adapter-specific). */
  claimNextQueuedRun(workerId: string): Promise<RunRecord | null>;
  /** Move a QUEUED run to RUNNING (no-op if already past QUEUED) so it leaves the claim path. */
  markRunning(runId: string): Promise<RunRecord | null>;
  /** Set a terminal status (COMPLETED/PARTIAL_FAILURE/FAILED) + completed_at. */
  finalizeRun(runId: string, status: RunStatus): Promise<RunRecord | null>;
  /**
   * Recover runs stuck **RUNNING** for longer than `olderThanMs` (default
   * {@link STUCK_RUN_THRESHOLD_MS}) by marking them FAILED + setting completed_at. In the in-process
   * job model an ALL_PROGRAMS/SITE run is advanced by a `ctx.waitUntil` task that does NOT survive a
   * container restart, leaving the run RUNNING forever (async runs are marked RUNNING synchronously,
   * so every orphan is RUNNING). Scoped to **unclaimed** RUNNING runs (`claimed_by IS NULL`): the
   * async path (`markRunning`) leaves claimed_by NULL, whereas `claimNextQueuedRun` stamps it, so a
   * legitimately CLAIMED worker job is never recovered. QUEUED runs are also left alone (the claim
   * path's "waiting for a worker" state, not an orphan). Run once per process on the first runs
   * access; the threshold guards against failing a live run. Returns the recovered run ids so the
   * caller can write an `audit_event` per run (the "every state change is audited" hard rule lives
   * above the store, which has no events binding).
   */
  failStuckRuns(olderThanMs?: number): Promise<string[]>;
}
