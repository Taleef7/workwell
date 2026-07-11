/**
 * scheduler.test.ts — scheduler unit tests (SQLite floor, no Postgres needed).
 */
import { after, test } from "node:test";
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
  type SchedulerTickDeps,
} from "./scheduler.ts";

const dbPaths: string[] = [];

/** Mock engine — returns COMPLIANT immediately; avoids full CQL compilation. */
const mockEngine: EvaluateMeasureBinding = {
  evaluate: async (input) => ({
    subjectId: "test-subject",
    measure: input.measureId,
    outcome: "COMPLIANT" as const,
    evidence: { expressionResults: [] },
  }),
};

async function freshStores(): Promise<Stores> {
  const dbPath = join(tmpdir(), `workwell-scheduler-${crypto.randomUUID()}.sqlite`);
  dbPaths.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return {
    runs: new SqliteRunStore(db),
    outcomes: new SqliteOutcomeStore(db),
    cases: new SqliteCaseStore(db),
    events: new SqliteCaseEventStore(db),
  } as unknown as Stores;
}

function deps(stores: Stores): SchedulerTickDeps {
  return {
    stores,
    engine: mockEngine,
    segments: [],
    employees: EMPLOYEES.slice(0, 2),
  };
}

async function createPriorSchedulerRun(stores: Stores, startedAt: string): Promise<void> {
  await stores.runs.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "scheduler",
    requestedScope: {},
    measurementPeriodStart: startedAt,
    measurementPeriodEnd: startedAt,
    startedAt,
    completedAt: startedAt,
    status: "COMPLETED",
  });
}

async function schedulerTriggerEvents(stores: Stores) {
  const events = await stores.events.recentAuditEvents(50);
  return events.filter((event) => event.eventType === "SCHEDULER_RUN_TRIGGERED");
}

after(() => {
  setSchedulerEnabled(false);
  for (const dbPath of dbPaths) {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("runTick remains skipped after restart when the persisted scheduler run is within the 23.5 h cooldown", async () => {
  const stores = await freshStores();
  const startedAt = "2026-07-01T00:00:00.000Z";
  await createPriorSchedulerRun(stores, startedAt);

  setSchedulerEnabled(true);
  setSchedulerEnabled(true); // simulated process restart: enabled state is re-initialized
  const fired = await runTick(deps(stores), Date.parse(startedAt) + 23 * 3_600_000);

  assert.equal(fired, false, "persisted prior run must retain its cooldown across restart");
  assert.equal((await schedulerTriggerEvents(stores)).length, 0, "skipped tick must not write an audit event");
});

test("runTick backfills promptly after a missed scheduler cycle", async () => {
  const stores = await freshStores();
  const startedAt = "2026-07-01T00:00:00.000Z";
  await createPriorSchedulerRun(stores, startedAt);

  setSchedulerEnabled(true);
  const fired = await runTick(deps(stores), Date.parse(startedAt) + 24 * 3_600_000 + 1);

  assert.equal(fired, true, "a missed 24-hour cycle must fire on the next tick");
  assert.equal((await schedulerTriggerEvents(stores)).length, 1, "a fired run must write its scheduler audit event");
});

test("runTick fires on the first enabled tick when no scheduler run has ever existed", async () => {
  const stores = await freshStores();

  setSchedulerEnabled(true);
  const fired = await runTick(deps(stores), Date.UTC(2026, 6, 1, 2, 0, 0));

  assert.equal(fired, true, "first activation must not wait for an in-memory wall-clock gate");
  assert.equal((await schedulerTriggerEvents(stores)).length, 1, "a fired run must write its scheduler audit event");
});

test("runTick never fires while the scheduler is disabled", async () => {
  const stores = await freshStores();

  setSchedulerEnabled(false);
  const fired = await runTick(deps(stores));

  assert.equal(fired, false);
  assert.equal((await stores.runs.listRuns()).length, 0);
  assert.equal((await schedulerTriggerEvents(stores)).length, 0);
});

test("every fired scheduler tick records SCHEDULER_RUN_TRIGGERED in audit_events", async () => {
  const stores = await freshStores();

  setSchedulerEnabled(true);
  const fired = await runTick(deps(stores));

  assert.equal(fired, true);
  const events = await schedulerTriggerEvents(stores);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actor, "scheduler");
});
