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
  id                UUID PRIMARY KEY,
  run_id            UUID NOT NULL REFERENCES ${SPIKE_SCHEMA}.runs(id),
  subject_id        TEXT NOT NULL,
  measure_id        TEXT NOT NULL,
  evaluation_period TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,
  evidence_json     JSONB NOT NULL,
  evaluated_at      TIMESTAMPTZ NOT NULL
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

-- Backfill columns added after the cases table's initial release. Postgres supports
-- ADD COLUMN IF NOT EXISTS, so these are idempotent and upgrade an existing spike schema
-- (the ceiling persists across test runs; CREATE TABLE IF NOT EXISTS would not alter it).
ALTER TABLE ${SPIKE_SCHEMA}.cases ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE ${SPIKE_SCHEMA}.cases ADD COLUMN IF NOT EXISTS closed_by TEXT;
ALTER TABLE ${SPIKE_SCHEMA}.outcomes ADD COLUMN IF NOT EXISTS evaluation_period TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.measures (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  policy_ref  TEXT,
  owner       TEXT,
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.measure_versions (
  id             TEXT PRIMARY KEY,
  measure_id     TEXT NOT NULL REFERENCES ${SPIKE_SCHEMA}.measures(id),
  version        TEXT NOT NULL,
  status         TEXT NOT NULL,
  spec_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  cql_text       TEXT NOT NULL DEFAULT '',
  compile_status TEXT NOT NULL DEFAULT 'NOT_COMPILED',
  change_summary TEXT,
  approved_by    TEXT,
  activated_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS spike_measure_versions_measure_id_idx ON ${SPIKE_SCHEMA}.measure_versions (measure_id);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.audit_packet_exports (
  id                 UUID PRIMARY KEY,
  packet_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  format             TEXT NOT NULL,
  generated_by       TEXT NOT NULL,
  generated_at       TIMESTAMPTZ NOT NULL,
  payload_hash       TEXT,
  payload_size_bytes BIGINT
);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.evidence_attachments (
  id              UUID PRIMARY KEY,
  case_id         TEXT NOT NULL,
  uploaded_by     TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  mime_type       TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  description     TEXT,
  uploaded_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS spike_evidence_attachments_case_id_idx ON ${SPIKE_SCHEMA}.evidence_attachments (case_id);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.scheduled_appointments (
  id               UUID PRIMARY KEY,
  case_id          TEXT NOT NULL,
  employee_id      TEXT NOT NULL,
  measure_id       TEXT NOT NULL,
  appointment_type TEXT NOT NULL,
  scheduled_at     TIMESTAMPTZ NOT NULL,
  location         TEXT NOT NULL,
  status           TEXT NOT NULL,
  notes            TEXT,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS spike_scheduled_appointments_case_id_idx ON ${SPIKE_SCHEMA}.scheduled_appointments (case_id);

-- Value-set governance (#108). Ceiling analogue of value_sets (V001 + V013), measure_value_set_links
-- (V001), terminology_mappings (V013). ids are TEXT (not UUID) to match the spike's TEXT measure ids
-- (value sets carry demo UUIDs + crypto.randomUUID() ids as strings; links FK measure_versions TEXT id).
CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.value_sets (
  id                TEXT PRIMARY KEY,
  oid               TEXT NOT NULL,
  name              TEXT NOT NULL,
  version           TEXT,
  codes_json        JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_resolved_at  TIMESTAMPTZ,
  canonical_url     TEXT,
  code_systems      TEXT[] NOT NULL DEFAULT '{}',
  source            TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  expansion_hash    TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  resolution_error  TEXT,
  UNIQUE (oid, version)
);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.measure_value_set_links (
  measure_version_id TEXT NOT NULL,
  value_set_id       TEXT NOT NULL REFERENCES ${SPIKE_SCHEMA}.value_sets(id),
  PRIMARY KEY (measure_version_id, value_set_id)
);

CREATE INDEX IF NOT EXISTS spike_mvsl_vs_idx ON ${SPIKE_SCHEMA}.measure_value_set_links (value_set_id);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.terminology_mappings (
  id                 TEXT PRIMARY KEY,
  local_code         TEXT NOT NULL,
  local_display      TEXT,
  local_system       TEXT NOT NULL,
  standard_code      TEXT NOT NULL,
  standard_display   TEXT,
  standard_system    TEXT NOT NULL,
  mapping_status     TEXT NOT NULL,
  mapping_confidence NUMERIC,
  reviewed_by        TEXT,
  reviewed_at        TIMESTAMPTZ,
  notes              TEXT,
  UNIQUE (local_system, local_code, standard_system, standard_code)
);

-- Outreach templates (#108 admin write CRUD). Ceiling analogue of outreach_templates (V007).
CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.outreach_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  type        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

-- Waivers (#108 admin write CRUD). Ceiling analogue of waivers (V009); FK columns are TEXT to
-- match the spike's TEXT employee/measure ids (display fields resolved at read time).
CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.waivers (
  id                   TEXT PRIMARY KEY,
  employee_external_id TEXT NOT NULL,
  measure_id           TEXT NOT NULL,
  measure_version_id   TEXT NOT NULL,
  exclusion_reason     TEXT NOT NULL,
  granted_by           TEXT NOT NULL,
  granted_at           TIMESTAMPTZ NOT NULL,
  expires_at           TIMESTAMPTZ,
  notes                TEXT,
  active               BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS spike_waivers_measure_idx ON ${SPIKE_SCHEMA}.waivers (measure_id, active);

-- Segments / risk-groups (#183 E11.3). cohort (rule_json predicate + per-employee overrides) →
-- applicable rule-set (segment_measures). Applicability gates case creation + roster display only;
-- never compliance (CQL Outcome Status stays authoritative — ADR-008/ADR-016). Reversibility:
-- zero ENABLED segments ⇒ everything applies (= pre-E11.3 behavior).
CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.segments (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  rule_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.segment_measures (
  segment_id   TEXT NOT NULL REFERENCES ${SPIKE_SCHEMA}.segments(id) ON DELETE CASCADE,
  measure_id   TEXT NOT NULL,
  PRIMARY KEY (segment_id, measure_id)
);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.segment_overrides (
  segment_id   TEXT NOT NULL REFERENCES ${SPIKE_SCHEMA}.segments(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  mode         TEXT NOT NULL,
  PRIMARY KEY (segment_id, external_id)
);

-- Quality-over-time snapshots (#E16). Materialized AGGREGATE of a population run's outcomes per
-- (measure, calendar month, scope): numerator/denominator + the 5 bucket counts at every scope level
-- (all -> tenant -> site -> provider). Read by the quality-history API + /programs trend so historical
-- population compliance is a bounded table read, never a re-scan of the per-subject outcomes (O(120k)
-- at scale). Aggregate-only (never per-employee); descriptive — CQL Outcome Status stays authoritative
-- (ADR-008). Idempotent on the UNIQUE key (last write wins).
CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.quality_snapshots (
  id            TEXT PRIMARY KEY,
  measure_id    TEXT NOT NULL,
  period        TEXT NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  scope_level   TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  tenant_id     TEXT,
  numerator     INTEGER NOT NULL,
  denominator   INTEGER NOT NULL,
  compliant     INTEGER NOT NULL,
  due_soon      INTEGER NOT NULL,
  overdue       INTEGER NOT NULL,
  missing_data  INTEGER NOT NULL,
  excluded      INTEGER NOT NULL,
  source_run_id TEXT,
  computed_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (measure_id, period, scope_level, scope_id)
);

CREATE INDEX IF NOT EXISTS spike_quality_snapshots_measure_period_idx
  ON ${SPIKE_SCHEMA}.quality_snapshots (measure_id, period);
CREATE INDEX IF NOT EXISTS spike_quality_snapshots_scope_idx
  ON ${SPIKE_SCHEMA}.quality_snapshots (scope_level, scope_id);
`;
