/**
 * Non-prod demo reset (#108 admin write CRUD) — TS port of DemoResetService. Clears the
 * volatile operational tables so the app returns to a clean baseline between demo sessions.
 * Static/seed data (measures, measure_versions, value_sets, measure_value_set_links,
 * terminology_mappings, outreach_templates) is preserved — the synthetic employee directory
 * is in-process, not a table.
 *
 * Like the Java service this intentionally clears `audit_events` (a sprint-sanctioned demo
 * tool) and is gated to non-production: the route returns 403 when SPRING_PROFILES_ACTIVE
 * includes `prod` (this function is never called there).
 */
import type { ActiveBackend } from "../stores/factory.ts";
import { SPIKE_SCHEMA } from "../stores/postgres/schema-pg.ts";

// Child-before-parent order (the floor has no CASCADE; explicit DELETEs keep it deliberate). This
// order also satisfies the Postgres ceiling's FKs — only run_logs/outcomes → runs are enforced, and
// both are deleted before runs.
const VOLATILE_TABLES = [
  "scheduled_appointments",
  "evidence_attachments",
  "case_actions",
  "cases",
  "outcomes",
  // Quality-over-time snapshots (#E16) are derived from runs (source_run_id) — clear them with the
  // volatile run data so a demo reset doesn't leave stale compliance history behind. No FK, so the
  // position is arbitrary; grouped with the run-derived tables.
  "quality_snapshots",
  "run_logs",
  "runs",
  "audit_events",
];

/**
 * Reset the volatile demo tables on the ACTIVE backend (the SQLite floor or the Postgres ceiling).
 * Routing through the selected backend — not the always-present `env.DB` floor binding — is what
 * makes the reset actually clear data when a `DATABASE_URL` ceiling is configured (otherwise it is a
 * silent no-op against the unused floor, leaving `workwell_spike` data in place). Non-prod use only.
 */
export async function resetDemoData(backend: ActiveBackend): Promise<void> {
  if (backend.kind === "postgres") {
    for (const table of VOLATILE_TABLES) {
      await backend.pool.query(`DELETE FROM ${SPIKE_SCHEMA}.${table}`);
    }
    return;
  }
  for (const table of VOLATILE_TABLES) {
    await backend.db.exec(`DELETE FROM ${table}`);
  }
}
