/**
 * scheduler.test.ts — E13 PR-3 scheduler unit tests (SQLite floor, no Postgres needed).
 *
 * Tests 2–5 share state: test 2 fires the first scheduler run, and tests 3–5
 * verify behaviour that depends on that run existing.  Run order is sequential
 * (node:test default).
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";

import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import type { Stores } from "../stores/factory.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import {
  setSchedulerEnabled,
  runTick,
  getSchedulerStatusFromStores,
  type SchedulerTickDeps,
} from "./scheduler.ts";

// ---------------------------------------------------------------------------
// Shared SQLite DB (tests 2–5 depend on state accumulated across test 2–3–4–5)
// ---------------------------------------------------------------------------

const dbPath = join(
  tmpdir(),
  `workwell-scheduler-${crypto.randomUUID()}.sqlite`
);

/** Definite-assignment: populated in before(). */
let stores!: Stores;

/** Mock engine — returns COMPLIANT immediately; avoids full CQL compilation. */
const mockEngine: EvaluateMeasureBinding = {
  evaluate: async (input) => ({
    subjectId: "test-subject",
    measure: input.measureId,
    outcome: "COMPLIANT" as const,
    evidence: { expressionResults: [] },
  }),
};

/** Build the deps object at call-time so it picks up the assigned `stores`. */
function deps(): SchedulerTickDeps {
  return {
    stores,
    engine: mockEngine,
    segments: [],
    employees: EMPLOYEES.slice(0, 2),
  };
}

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  stores = {
    runs: new SqliteRunStore(db),
    outcomes: new SqliteOutcomeStore(db),
    cases: new SqliteCaseStore(db),
    events: new SqliteCaseEventStore(db),
  } as unknown as Stores;
  // Ensure scheduler starts disabled for test isolation.
  setSchedulerEnabled(false);
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Test 1 — disabled guard
// ---------------------------------------------------------------------------

test("runTick returns false when scheduler is disabled", async () => {
  setSchedulerEnabled(false);
  const fired = await runTick(deps());
  assert.equal(fired, false, "Expected false — scheduler is disabled");
});

// ---------------------------------------------------------------------------
// Test 1b — P2-1: first-fire gate honors the advertised nextFireAt
// ---------------------------------------------------------------------------

test("runTick returns false before the first-fire window (honors nextFireAt, no prior run)", async () => {
  // Enable at midnight UTC so firstFireAt = today 06:00 UTC.
  const today = new Date();
  const midnightUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0);
  setSchedulerEnabled(true, midnightUTC);
  // Tick at 02:00 UTC — before the 06:00 first-fire window.
  const twoAM = midnightUTC + 2 * 3_600_000;
  const fired = await runTick(deps(), twoAM);
  assert.equal(fired, false, "Expected false — tick is before the first-fire window (02:00 < 06:00 UTC)");
  setSchedulerEnabled(false);
});

// ---------------------------------------------------------------------------
// Test 2 — happy path: fires run + writes audit event
// ---------------------------------------------------------------------------

test("runTick fires an ALL_PROGRAMS run and writes SCHEDULER_RUN_TRIGGERED audit when enabled", async () => {
  // Enable at midnight UTC → firstFireAt = today 06:00. Simulate tick at 07:00 UTC (past the window).
  const today = new Date();
  const midnightUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0);
  setSchedulerEnabled(true, midnightUTC);
  const sevenAM = midnightUTC + 7 * 3_600_000;
  const fired = await runTick(deps(), sevenAM);
  assert.equal(fired, true, "Expected true — past the first-fire window, no prior run exists");

  // A scheduler-tagged run must exist.
  const runs = await stores.runs.listRuns(10);
  const schedulerRun = runs.find((r) => r.triggeredBy === "scheduler");
  assert.ok(schedulerRun, "A run with triggeredBy='scheduler' should be in the runs table");
  assert.equal(schedulerRun.scopeType, "ALL_PROGRAMS");

  // The audit event must have been written BEFORE the run.
  const events = await stores.events.recentAuditEvents(50);
  const triggerEvent = events.find((e) => e.eventType === "SCHEDULER_RUN_TRIGGERED");
  assert.ok(triggerEvent, "SCHEDULER_RUN_TRIGGERED audit event should exist");
  assert.equal(triggerEvent.actor, "scheduler");
});

// ---------------------------------------------------------------------------
// Test 3 — debounce: second call within the 23.5 h window returns false
// ---------------------------------------------------------------------------

test("runTick skips when called again within the debounce window (< 23.5 h since last run)", async () => {
  // Scheduler is still enabled from test 2.  A run was created moments ago,
  // so elapsed time is near zero — well within the 23.5 h threshold.
  const fired = await runTick(deps());
  assert.equal(fired, false, "Expected false — debounced because a run was just created");
});

// ---------------------------------------------------------------------------
// Test 4 — getSchedulerStatusFromStores reflects enabled state + lastRunAt
// ---------------------------------------------------------------------------

test("getSchedulerStatusFromStores reflects enabled=true, lastRunAt, and nextFireAt after a run", async () => {
  // Scheduler still enabled from test 2.
  const status = await getSchedulerStatusFromStores(stores);
  assert.equal(status.enabled, true);
  assert.ok(status.lastRunAt !== null, "lastRunAt should be populated after a run");
  assert.ok(
    status.lastRunStatus === "COMPLETED" || status.lastRunStatus === "PARTIAL_FAILURE",
    `lastRunStatus should be a terminal status, got: ${status.lastRunStatus}`
  );
  assert.ok(status.nextFireAt !== null, "nextFireAt should be set when enabled");
});

// ---------------------------------------------------------------------------
// Test 5 — getSchedulerStatusFromStores returns nextFireAt=null when disabled
// ---------------------------------------------------------------------------

test("getSchedulerStatusFromStores returns nextFireAt=null when scheduler is disabled", async () => {
  setSchedulerEnabled(false);
  const status = await getSchedulerStatusFromStores(stores);
  assert.equal(status.enabled, false);
  assert.equal(status.nextFireAt, null, "nextFireAt must be null when disabled");
  // lastRunAt should still reflect the run from test 2.
  assert.ok(status.lastRunAt !== null, "lastRunAt should still be populated from the earlier run");
});
