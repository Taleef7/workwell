/**
 * SQLite/D1 portable-floor DDL for the run store (spike, #103).
 *
 * Mirrors the shape of the Postgres `runs` + `run_logs` tables (docs/DATA_MODEL.md)
 * reduced to the SQLite floor: TEXT timestamps/UUIDs, INTEGER autoincrement log id,
 * TEXT JSON column. The Postgres ceiling adapter (#104) keeps TIMESTAMPTZ/JSONB/uuid.
 *
 * NOTE: this is spike scaffolding to prove the storage contract. The CANONICAL
 * schema + migrations remain Taleef-owned (CLAUDE.md hard rule) — nothing here is
 * applied to a production database.
 */
export const RUN_STORE_FLOOR_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS runs (
  id                        TEXT PRIMARY KEY,
  status                    TEXT NOT NULL,
  scope_type                TEXT NOT NULL,
  scope_id                  TEXT,
  triggered_by              TEXT,
  requested_scope_json      TEXT NOT NULL DEFAULT '{}',
  measurement_period_start  TEXT NOT NULL,
  measurement_period_end    TEXT NOT NULL,
  claimed_by                TEXT,
  started_at                TEXT NOT NULL,
  completed_at              TEXT
);

CREATE INDEX IF NOT EXISTS runs_status_started_idx ON runs (status, started_at);

CREATE TABLE IF NOT EXISTS run_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(id),
  ts        TEXT NOT NULL,
  level     TEXT NOT NULL,
  message   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_logs_run_id_idx ON run_logs (run_id);

CREATE TABLE IF NOT EXISTS outcomes (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  subject_id    TEXT NOT NULL,
  measure_id    TEXT NOT NULL,
  status        TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evaluated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS outcomes_run_id_idx ON outcomes (run_id);

/* Cases (#107). Floor analogue of the canonical cases table (docs/DATA_MODEL.md):
   measure_id (slug) stands in for the canonical measure_version_id UUID. The
   idempotency invariant is UNIQUE (employee_id, measure_id, evaluation_period) — a
   rerun upserts, never duplicates. (Block comment: this DDL is newline-flattened.) */
CREATE TABLE IF NOT EXISTS cases (
  id                     TEXT PRIMARY KEY,
  employee_id            TEXT NOT NULL,
  measure_id             TEXT NOT NULL,
  evaluation_period      TEXT NOT NULL,
  status                 TEXT NOT NULL,
  priority               TEXT NOT NULL,
  assignee               TEXT,
  next_action            TEXT,
  current_outcome_status TEXT NOT NULL,
  last_run_id            TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  closed_at              TEXT,
  closed_reason          TEXT,
  closed_by              TEXT,
  UNIQUE (employee_id, measure_id, evaluation_period)
);

CREATE INDEX IF NOT EXISTS cases_status_idx ON cases (status);

/* Case actions (#107). Floor analogue of case_actions (docs/DATA_MODEL.md): one row per
   operator/system action on a case (ASSIGNED, ESCALATED, OUTREACH_SENT, …). payload_json
   is the action detail. INTEGER autoincrement id doubles as the stable tiebreak sort_key. */
CREATE TABLE IF NOT EXISTS case_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id       TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  payload_json  TEXT,
  performed_by  TEXT,
  performed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS case_actions_case_id_idx ON case_actions (case_id);

/* Audit events (#107). Append-only ledger (docs/DATA_MODEL.md): every state change writes
   one row (CLAUDE.md hard rule). measure_version_id holds the floor measure slug. The
   case timeline is audit_events (excl CASE_VIEWED) UNION case_actions ordered by occurred_at. */
CREATE TABLE IF NOT EXISTS audit_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type           TEXT NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id            TEXT,
  actor                TEXT,
  ref_run_id           TEXT,
  ref_case_id          TEXT,
  ref_measure_version_id TEXT,
  payload_json         TEXT,
  occurred_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_ref_case_id_idx ON audit_events (ref_case_id);
`;

/**
 * Columns added to existing tables after their initial CREATE. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and `CREATE TABLE IF NOT EXISTS` won't alter a table that
 * already exists — so a floor DB created by an earlier release keeps the old shape and a
 * SELECT of the new column fails. `migrateFloorSchema` backfills these idempotently by
 * checking `PRAGMA table_info` first. Add an entry here whenever a column is introduced.
 */
const FLOOR_COLUMN_BACKFILL: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: "cases", column: "closed_reason", ddl: "closed_reason TEXT" },
  { table: "cases", column: "closed_by", ddl: "closed_by TEXT" },
];

interface MinimalDb {
  prepare(sql: string): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> };
  exec(sql: string): Promise<unknown>;
}

/** Idempotently add any missing backfill columns to an existing floor DB. Safe to run every boot. */
export async function migrateFloorSchema(db: MinimalDb): Promise<void> {
  for (const { table, column, ddl } of FLOOR_COLUMN_BACKFILL) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!(results ?? []).some((r) => r.name === column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }
}
