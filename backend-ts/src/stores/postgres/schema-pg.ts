/**
 * Postgres-ceiling DDL for the run/outcome stores (spike, #104).
 *
 * The Postgres analogue of the SQLite floor (`../sqlite/schema.ts`): same logical
 * shape, native ceiling types — TIMESTAMPTZ instead of TEXT timestamps, JSONB
 * instead of TEXT JSON, IDENTITY instead of AUTOINCREMENT. This is what lets the
 * SAME `RunStore`/`OutcomeStore` contract pass on both backends ("SQLite/D1 define
 * the portable floor; Postgres provides the performance ceiling").
 *
 * Isolated in a dedicated `workwell_spike` schema so it NEVER collides with the
 * canonical Flyway-managed `public` tables. The CANONICAL schema + migrations
 * remain Taleef-owned (CLAUDE.md hard rule) — nothing here touches them.
 */
export const SPIKE_SCHEMA = "workwell_spike";

export const RUN_STORE_PG_DDL = /* sql */ `
CREATE SCHEMA IF NOT EXISTS ${SPIKE_SCHEMA};

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.runs (
  id                        UUID PRIMARY KEY,
  status                    TEXT NOT NULL,
  scope_type                TEXT NOT NULL,
  scope_id                  TEXT,
  triggered_by              TEXT,
  requested_scope_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  measurement_period_start  TIMESTAMPTZ NOT NULL,
  measurement_period_end    TIMESTAMPTZ NOT NULL,
  claimed_by                TEXT,
  started_at                TIMESTAMPTZ NOT NULL,
  completed_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS spike_runs_status_started_idx
  ON ${SPIKE_SCHEMA}.runs (status, started_at);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.run_logs (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id    UUID NOT NULL REFERENCES ${SPIKE_SCHEMA}.runs(id),
  ts        TIMESTAMPTZ NOT NULL,
  level     TEXT NOT NULL,
  message   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS spike_run_logs_run_id_idx
  ON ${SPIKE_SCHEMA}.run_logs (run_id);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.outcomes (
  id            UUID PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES ${SPIKE_SCHEMA}.runs(id),
  subject_id    TEXT NOT NULL,
  measure_id    TEXT NOT NULL,
  status        TEXT NOT NULL,
  evidence_json JSONB NOT NULL,
  evaluated_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS spike_outcomes_run_id_idx
  ON ${SPIKE_SCHEMA}.outcomes (run_id);
`;
