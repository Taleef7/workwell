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
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id),
  subject_id        TEXT NOT NULL,
  measure_id        TEXT NOT NULL,
  evaluation_period TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  evaluated_at      TEXT NOT NULL
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

/* Measures + measure_versions (#107 authoring). Floor analogue of the canonical tables
   (docs/DATA_MODEL.md): tags + spec_json are JSON TEXT on the floor (TEXT[]/JSONB on the
   ceiling). Seeded from MEASURE_CATALOG on first use; create/lifecycle mutate these rows.
   One latest version per measure for the catalog seed (version cloning is a later slice). */
CREATE TABLE IF NOT EXISTS measures (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  policy_ref  TEXT,
  owner       TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS measure_versions (
  id             TEXT PRIMARY KEY,
  measure_id     TEXT NOT NULL REFERENCES measures(id),
  version        TEXT NOT NULL,
  status         TEXT NOT NULL,
  spec_json      TEXT NOT NULL DEFAULT '{}',
  cql_text       TEXT NOT NULL DEFAULT '',
  compile_status TEXT NOT NULL DEFAULT 'NOT_COMPILED',
  change_summary TEXT,
  approved_by    TEXT,
  activated_at   TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS measure_versions_measure_id_idx ON measure_versions (measure_id);

/* Audit packet exports (#108 auditor packets). Floor analogue of audit_packet_exports
   (docs/DATA_MODEL.md): one row per generated auditor packet (RUN / MEASURE_VERSION / CASE),
   recording type, entity, format, actor, the SHA-256 payload hash + byte size for integrity.
   Written alongside an AUDIT_PACKET_GENERATED audit_event on every packet build. */
CREATE TABLE IF NOT EXISTS audit_packet_exports (
  id                 TEXT PRIMARY KEY,
  packet_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  format             TEXT NOT NULL,
  generated_by       TEXT NOT NULL,
  generated_at       TEXT NOT NULL,
  payload_hash       TEXT,
  payload_size_bytes INTEGER
);

/* Evidence attachments (#108). Floor analogue of evidence_attachments (docs/DATA_MODEL.md /
   canonical V006): file METADATA only — the bytes live in the BUCKET binding under storage_key.
   case_id is the floor case id (TEXT). */
CREATE TABLE IF NOT EXISTS evidence_attachments (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL,
  uploaded_by     TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  description     TEXT,
  uploaded_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_attachments_case_id_idx ON evidence_attachments (case_id);

/* Scheduled appointments (#108). Floor analogue of scheduled_appointments (canonical V005):
   employee_id/measure_id are the floor case's subject + measure slug (TEXT). The outreach_records
   side of V005 is NOT modeled — TS represents outreach as case_actions, not a separate table. */
CREATE TABLE IF NOT EXISTS scheduled_appointments (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL,
  employee_id      TEXT NOT NULL,
  measure_id       TEXT NOT NULL,
  appointment_type TEXT NOT NULL,
  scheduled_at     TEXT NOT NULL,
  location         TEXT NOT NULL,
  status           TEXT NOT NULL,
  notes            TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduled_appointments_case_id_idx ON scheduled_appointments (case_id);

/* Value-set governance (#108). Floor analogue of value_sets (V001 + V013 columns),
   measure_value_set_links (V001), and terminology_mappings (V013). codes_json / code_systems
   are JSON TEXT on the floor (JSONB / text[] on the ceiling). measure_version_id is the floor
   version id (<measureId>-<version> TEXT). */
CREATE TABLE IF NOT EXISTS value_sets (
  id                TEXT PRIMARY KEY,
  oid               TEXT NOT NULL,
  name              TEXT NOT NULL,
  version           TEXT,
  codes_json        TEXT NOT NULL DEFAULT '[]',
  last_resolved_at  TEXT,
  canonical_url     TEXT,
  code_systems      TEXT NOT NULL DEFAULT '[]',
  source            TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  expansion_hash    TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  resolution_error  TEXT,
  UNIQUE (oid, version)
);

CREATE TABLE IF NOT EXISTS measure_value_set_links (
  measure_version_id TEXT NOT NULL,
  value_set_id       TEXT NOT NULL REFERENCES value_sets(id),
  PRIMARY KEY (measure_version_id, value_set_id)
);

CREATE INDEX IF NOT EXISTS measure_value_set_links_vs_idx ON measure_value_set_links (value_set_id);

CREATE TABLE IF NOT EXISTS terminology_mappings (
  id                 TEXT PRIMARY KEY,
  local_code         TEXT NOT NULL,
  local_display      TEXT,
  local_system       TEXT NOT NULL,
  standard_code      TEXT NOT NULL,
  standard_display   TEXT,
  standard_system    TEXT NOT NULL,
  mapping_status     TEXT NOT NULL,
  mapping_confidence REAL,
  reviewed_by        TEXT,
  reviewed_at        TEXT,
  notes              TEXT,
  UNIQUE (local_system, local_code, standard_system, standard_code)
);

/* Outreach templates (#108 admin write CRUD). Floor analogue of outreach_templates (V007).
   active is INTEGER 0/1 on the floor (BOOLEAN on the ceiling). */
CREATE TABLE IF NOT EXISTS outreach_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  type        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);
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
  { table: "outcomes", column: "evaluation_period", ddl: "evaluation_period TEXT NOT NULL DEFAULT ''" },
];

interface MinimalDb {
  prepare(sql: string): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> };
  exec(sql: string): Promise<unknown>;
}

/** Idempotently add any missing backfill columns to an existing floor DB. Safe to run every boot. */
export async function migrateFloorSchema(db: MinimalDb): Promise<void> {
  for (const { table, column, ddl } of FLOOR_COLUMN_BACKFILL) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const cols = results ?? [];
    // Empty table_info ⇒ the table doesn't exist yet; the CREATE TABLE IF NOT EXISTS DDL
    // creates it (with the column) — nothing to backfill, and ALTERing it would error.
    if (cols.length === 0) continue;
    if (!cols.some((r) => r.name === column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }
}
