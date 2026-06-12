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
`;
