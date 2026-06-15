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
import type { CloudDatabase } from "@mieweb/cloud";

// Child-before-parent order (the floor has no CASCADE; explicit DELETEs keep it deliberate).
const VOLATILE_TABLES = [
  "scheduled_appointments",
  "evidence_attachments",
  "case_actions",
  "cases",
  "outcomes",
  "run_logs",
  "runs",
  "audit_events",
];

export async function resetDemoData(db: CloudDatabase): Promise<void> {
  for (const table of VOLATILE_TABLES) {
    await db.exec(`DELETE FROM ${table}`);
  }
}
