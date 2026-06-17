/**
 * Demo-reset backend dispatch (#109): the reset must hit the SELECTED backend, not the always-present
 * SQLite floor binding — otherwise a Postgres-backed demo silently leaves `workwell_spike` data.
 * node --import tsx --test src/admin/demo-reset.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetDemoData } from "./demo-reset.ts";

const EXPECTED_ORDER = [
  "scheduled_appointments",
  "evidence_attachments",
  "case_actions",
  "cases",
  "outcomes",
  "run_logs",
  "runs",
  "audit_events",
];

test("resetDemoData(postgres): schema-qualified DELETEs over the pool, FK-safe order", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [] };
    },
  };
  await resetDemoData({ kind: "postgres", pool } as never);
  assert.deepEqual(
    queries,
    EXPECTED_ORDER.map((t) => `DELETE FROM workwell_spike.${t}`),
    "Pg reset deletes the spike-qualified volatile tables, run_logs/outcomes before runs",
  );
});

test("resetDemoData(sqlite): bare DELETEs over the floor binding", async () => {
  const execs: string[] = [];
  const db = {
    async exec(sql: string) {
      execs.push(sql);
    },
  };
  await resetDemoData({ kind: "sqlite", db } as never);
  assert.deepEqual(
    execs,
    EXPECTED_ORDER.map((t) => `DELETE FROM ${t}`),
    "floor reset deletes the bare volatile tables in the same child-before-parent order",
  );
});
