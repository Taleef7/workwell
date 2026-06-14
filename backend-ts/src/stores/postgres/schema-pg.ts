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

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.cases (
  id                     UUID PRIMARY KEY,
  employee_id            TEXT NOT NULL,
  measure_id             TEXT NOT NULL,
  evaluation_period      TEXT NOT NULL,
  status                 TEXT NOT NULL,
  priority               TEXT NOT NULL,
  assignee               TEXT,
  next_action            TEXT,
  current_outcome_status TEXT NOT NULL,
  last_run_id            UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  closed_at              TIMESTAMPTZ,
  closed_reason          TEXT,
  closed_by              TEXT,
  UNIQUE (employee_id, measure_id, evaluation_period)
);

CREATE INDEX IF NOT EXISTS spike_cases_status_idx ON ${SPIKE_SCHEMA}.cases (status);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.case_actions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id       UUID NOT NULL,
  action_type   TEXT NOT NULL,
  payload_json  JSONB,
  performed_by  TEXT,
  performed_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS spike_case_actions_case_id_idx ON ${SPIKE_SCHEMA}.case_actions (case_id);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.audit_events (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type             TEXT NOT NULL,
  entity_type            TEXT NOT NULL,
  entity_id              TEXT,
  actor                  TEXT,
  ref_run_id             TEXT,
  ref_case_id            TEXT,
  ref_measure_version_id TEXT,
  payload_json           JSONB,
  occurred_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS spike_audit_events_ref_case_id_idx ON ${SPIKE_SCHEMA}.audit_events (ref_case_id);
`;
