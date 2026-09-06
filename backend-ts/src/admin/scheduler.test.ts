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
import type { EvaluateMeasureBinding } from "@work-well/measure-engine";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { fixtureWebChartClient } from "../engine/ingress/webchart/webchart-client.ts";
import {
  setSchedulerEnabled,
  runTick,
  shouldSkipTickWithoutDb,
  type SchedulerTickDeps,
  computeNextFireAt,
  shouldFireAt,
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

test("a normal cycle boundary waits for the ANCHOR, not for 24 hours to elapse", async () => {
  // Changed by the anchor (Task 11), deliberately. This used to assert that 24 h + 1 ms after the last
  // run fires immediately — a cadence, not a schedule. Under an anchor the nightly run happens at the
  // same wall-clock time every day, so a run that started at midnight is next due at 12:00, not at
  // midnight again. That is the whole point: without it one late run drags every later one with it.
  const stores = await freshStores();
  const startedAt = "2026-07-01T00:00:00.000Z";
  await createPriorSchedulerRun(stores, startedAt);

  setSchedulerEnabled(true);
  assert.equal(await runTick(deps(stores), Date.parse(startedAt) + 24 * 3_600_000 + 1), false, "00:00 is not the anchor");
  assert.equal((await schedulerTriggerEvents(stores)).length, 0);

  assert.equal(await runTick(deps(stores), Date.parse("2026-07-02T12:00:00.000Z")), true, "12:00 UTC is");
  assert.equal((await schedulerTriggerEvents(stores)).length, 1, "a fired run must write its scheduler audit event");
});

test("runTick still backfills promptly after a GENUINELY missed cycle", async () => {
  // The property the previous test was protecting, kept: an instance down for days must not wait for
  // the next anchor on top of the outage. It fires on the first tick after it comes back, because the
  // anchor it should have fired on is already in the past.
  const stores = await freshStores();
  await createPriorSchedulerRun(stores, "2026-07-01T12:00:00.000Z");

  setSchedulerEnabled(true);
  const fired = await runTick(deps(stores), Date.parse("2026-07-04T03:17:00.000Z"));

  assert.equal(fired, true, "two missed anchors must not become a third day of waiting");
  assert.equal((await schedulerTriggerEvents(stores)).length, 1);
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

test("a configured scheduler tick includes the live WebChart population", async () => {
  const stores = await freshStores();
  const configured = {
    ...deps(stores),
    webChartEnv: {
      WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
      WORKWELL_WEBCHART_API_KEY: "fixture-key",
    },
    webChartClient: fixtureWebChartClient([{
      resourceType: "Bundle",
      type: "collection",
      entry: [{ resource: { resourceType: "Patient", id: "scheduled-live-1", name: [{ text: "Scheduled Live" }] } }],
    }]),
  };

  setSchedulerEnabled(true);
  const fired = await runTick(configured);

  assert.equal(fired, true);
  const rows = await stores.outcomes.listLatestPopulationOutcomes({ measureId: "audiogram" });
  assert.ok(rows.some((row) => row.subjectId === "wc|scheduled-live-1"), "nightly population includes WebChart subjects");
});

// ---------------------------------------------------------------------------
// Compute-cost guardrail (#322): a tick must not touch the DB unless it may fire.
//
// Regression context: schedulerTick did ensureSegmentSeed + getStores + engineForEnv +
// listSegments + getLastRunByTriggeredBy on EVERY 5-minute tick — ~1,300 DB round trips/day
// to evaluate a 23.5 h debounce. Against Neon's 5-minute suspend timeout the compute never
// suspended and billed 24/7, exhausting the plan's monthly compute quota (live outage
// 2026-07-18 → 07-22). The gate below is what keeps the compute asleep between daily runs.
// ---------------------------------------------------------------------------

test("shouldSkipTickWithoutDb skips every tick while the scheduler is disabled (zero DB work)", () => {
  setSchedulerEnabled(false);
  assert.equal(shouldSkipTickWithoutDb(Date.now()), true);
});

test("shouldSkipTickWithoutDb consults the DB on the first tick after restart (#268 durability)", () => {
  setSchedulerEnabled(true); // also clears the in-memory due cache
  assert.equal(
    shouldSkipTickWithoutDb(Date.now()),
    false,
    "a cold cache must fall through to the persisted last-run read",
  );
});

test("after a debounced tick, later ticks skip the DB until the run is actually due", async () => {
  const stores = await freshStores();
  const startedAt = "2026-07-01T06:00:00.000Z";
  await createPriorSchedulerRun(stores, startedAt);
  setSchedulerEnabled(true);

  const base = Date.parse(startedAt);
  const fired = await runTick(deps(stores), base + 3 * 3_600_000);
  assert.equal(fired, false, "3 h after the last run is well inside the 23.5 h cooldown");

  // The tick learned when the next run is due, so intervening ticks cost zero DB round trips. The
  // cached instant is the ANCHOR (06:00 + 23.5 h floor lands at 05:30, so the next 12:00 is the day
  // after), not `last + 23.5 h` — otherwise the cache and the tick would disagree about the schedule
  // and every tick in between would pay a query to be told to wait.
  assert.equal(shouldSkipTickWithoutDb(base + 4 * 3_600_000), true);
  assert.equal(shouldSkipTickWithoutDb(base + 23.5 * 3_600_000), true, "the debounce lapsed but the anchor has not arrived");
  assert.equal(shouldSkipTickWithoutDb(base + 29 * 3_600_000), true);

  // ...and it stops skipping at the anchor, so the schedule is preserved.
  assert.equal(shouldSkipTickWithoutDb(base + 30 * 3_600_000), false, "06:00 + 30 h = 12:00 the next day");
});

test("after a fired tick, later ticks skip the DB until the next cycle is due", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  const now = Date.UTC(2026, 6, 1, 6, 0, 0);

  const fired = await runTick(deps(stores), now);
  assert.equal(fired, true, "no prior scheduler run — the first enabled tick fires");

  assert.equal(shouldSkipTickWithoutDb(now + 3_600_000), true);
  assert.equal(shouldSkipTickWithoutDb(now + 23.5 * 3_600_000), true, "the debounce lapsed; the anchor has not");
  assert.equal(shouldSkipTickWithoutDb(now + 30 * 3_600_000), false, "06:00 + 30 h = the next 12:00 anchor");
});

test("re-enabling the scheduler clears the due cache so the toggle takes effect promptly", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  const now = Date.UTC(2026, 6, 1, 6, 0, 0);
  await runTick(deps(stores), now);
  assert.equal(shouldSkipTickWithoutDb(now + 3_600_000), true);

  setSchedulerEnabled(true); // admin toggle / process restart
  assert.equal(
    shouldSkipTickWithoutDb(now + 3_600_000),
    false,
    "a re-enable must re-consult the persisted cadence rather than trust a stale cache",
  );
});

// ---------------------------------------------------------------------------
// Codex P1 (#322 review): a failed tick must not poison the due gate.
//
// The due cache is an optimisation layered over the persisted cadence. If it is booked BEFORE the
// run is durably created and the pre-run write then throws (a transient DB error — precisely the
// condition this whole change is about), every later tick would skip the DB for 23.5 h and the
// daily recompute would be silently lost with no run to show for it. The cache must only be
// trusted once a scheduler run actually exists.
// ---------------------------------------------------------------------------

/** Stores whose audit append fails, simulating a transient DB error before the run is created. */
function storesWithFailingAudit(stores: Stores): Stores {
  const events = Object.create(stores.events) as Stores["events"];
  events.appendAudit = async () => {
    throw new Error("transient database error");
  };
  return { ...stores, events } as Stores;
}

test("a tick that fails before persisting its run leaves the gate open for a retry", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  const now = Date.UTC(2026, 6, 1, 6, 0, 0);

  await assert.rejects(
    () => runTick({ ...deps(stores), stores: storesWithFailingAudit(stores) }, now),
    /transient database error/,
  );

  assert.equal(
    (await stores.runs.listRuns()).length,
    0,
    "no scheduler run was persisted, so nothing justifies a 23.5 h cooldown",
  );
  assert.equal(
    shouldSkipTickWithoutDb(now + 60_000),
    false,
    "a failed tick must not book the next cycle — the recompute would be lost for a full day",
  );
});

test("the retry after a failed tick actually fires and records its run", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  const now = Date.UTC(2026, 6, 1, 6, 0, 0);

  await assert.rejects(() => runTick({ ...deps(stores), stores: storesWithFailingAudit(stores) }, now));

  // Next tick, database recovered.
  const fired = await runTick(deps(stores), now + 60_000);
  assert.equal(fired, true, "the daily recompute must survive a transient failure");
  assert.equal((await schedulerTriggerEvents(stores)).length, 1);
  assert.equal(shouldSkipTickWithoutDb(now + 120_000), true, "and only then does the gate close");
});

// ---------------------------------------------------------------------------
// Codex P2 (#323 review): overlapping ticks must not both create a run.
//
// The due cache alone cannot prevent this. If a tick stalls inside appendAudit/planManualRun for
// longer than the timer period — the Postgres pool sets no query timeout, so a hung database does
// exactly that — the next timer callback finds the gate null/expired and proceeds. Both ticks may
// already have read "no prior scheduler run", so when the database recovers both append a trigger
// event and create an ALL_PROGRAMS run. Concurrency needs its own single-flight guard.
// ---------------------------------------------------------------------------

test("a second tick is a no-op while an earlier tick is still in flight", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  const now = Date.UTC(2026, 6, 1, 6, 0, 0);

  // Stall the first tick inside its pre-run write, mimicking a hung database.
  let releaseStalledWrite!: () => void;
  const stalled = new Promise<void>((resolve) => {
    releaseStalledWrite = resolve;
  });
  const hangingEvents = Object.create(stores.events) as Stores["events"];
  const realAppendAudit = stores.events.appendAudit.bind(stores.events);
  hangingEvents.appendAudit = async (input) => {
    await stalled;
    return realAppendAudit(input);
  };

  const first = runTick({ ...deps(stores), stores: { ...stores, events: hangingEvents } as Stores }, now);

  // Timer fires again while the first tick is still blocked on the database.
  const second = await runTick(deps(stores), now + 15 * 60_000);
  assert.equal(second, false, "an overlapping tick must not start a second ALL_PROGRAMS run");

  releaseStalledWrite();
  assert.equal(await first, true, "the original tick still completes normally");

  assert.equal(
    (await schedulerTriggerEvents(stores)).length,
    1,
    "exactly one SCHEDULER_RUN_TRIGGERED — a double-fire would write two",
  );
});

test("the single-flight guard is released so the next cycle can still fire", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  const now = Date.UTC(2026, 6, 1, 6, 0, 0);

  // A failing tick must release the guard, not wedge the scheduler permanently.
  await assert.rejects(() => runTick({ ...deps(stores), stores: storesWithFailingAudit(stores) }, now));

  const fired = await runTick(deps(stores), now + 60_000);
  assert.equal(fired, true, "a thrown tick must not leave the scheduler permanently blocked");
});

// ── The nightly anchor hour (ADR-075 / MM-1 U2 Task 11) ──────────────────────
//
// The cadence used to be "24 hours after the last run", which is not a schedule: one late run drags
// every later run with it and the nightly job walks around the clock. These pin the anchor, and — the
// part that matters — that the TICK honours it, not only the status display. The two used to be
// independent calculations, so changing the display alone would have moved the reported time and
// nothing else.

const H = 3_600_000;
const GAP = 23.5 * H;

test("computeNextFireAt returns the next occurrence of the anchor hour, not last-run + 24h", () => {
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T03:00:00Z"), nowMs: Date.parse("2027-03-04T03:05:00Z"), anchorHourUtc: 12, minGapMs: 6 * H }),
    "2027-03-04T12:00:00.000Z",
  );
});

test("after today's anchor has passed, the next fire is tomorrow's", () => {
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T12:00:00Z"), nowMs: Date.parse("2027-03-04T13:00:00Z"), anchorHourUtc: 12, minGapMs: 6 * H }),
    "2027-03-05T12:00:00.000Z",
  );
});

test("the min-gap is a FLOOR: an anchor inside the debounce window is pushed past it", () => {
  // Ran at 11:00, anchor at 12:00, six-hour floor. Firing at 12:00 would be twice in an hour.
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T11:00:00Z"), nowMs: Date.parse("2027-03-04T11:05:00Z"), anchorHourUtc: 12, minGapMs: 6 * H }),
    "2027-03-05T12:00:00.000Z",
  );
});

test("a deployment that has never run fires on the next tick, not after a day of waiting", () => {
  const now = Date.parse("2027-03-04T03:00:00Z");
  assert.equal(computeNextFireAt({ lastRunAtMs: null, nowMs: now, anchorHourUtc: 12, minGapMs: 6 * H }), new Date(now).toISOString());
  assert.equal(shouldFireAt({ lastRunAtMs: null, nowMs: now, anchorHourUtc: 12, minGapMs: 6 * H }), true);
});

test("a clock exactly at the anchor fires now, not in 24 hours", () => {
  const at = Date.parse("2027-03-04T12:00:00Z");
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-03T12:00:00Z"), nowMs: at, anchorHourUtc: 12, minGapMs: 6 * H }),
    new Date(at).toISOString(),
  );
  assert.equal(shouldFireAt({ lastRunAtMs: Date.parse("2027-03-03T12:00:00Z"), nowMs: at, anchorHourUtc: 12, minGapMs: 6 * H }), true);
});

test("a late run does not drag the next one late — the anchor holds across days", () => {
  // The whole point. Ran four hours late at 16:00; the next fire is still 12:00, not 16:00.
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T16:00:00Z"), nowMs: Date.parse("2027-03-04T16:01:00Z"), anchorHourUtc: 12, minGapMs: GAP }),
    "2027-03-06T12:00:00.000Z",
  );
});

test("the anchor hour is configurable, and a nonsense value degrades to 12 UTC", () => {
  const base = { lastRunAtMs: Date.parse("2027-03-04T00:30:00Z"), nowMs: Date.parse("2027-03-04T00:31:00Z"), minGapMs: 1 * H };
  assert.equal(computeNextFireAt({ ...base, anchorHourUtc: 0 }), "2027-03-05T00:00:00.000Z");
  assert.equal(computeNextFireAt({ ...base, anchorHourUtc: 23 }), "2027-03-04T23:00:00.000Z");
  for (const bad of ["25", "-1", "abc", "12.5"]) {
    process.env.WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC = bad;
    assert.equal(computeNextFireAt(base), "2027-03-04T12:00:00.000Z", `bad value ${bad} must fall back to 12`);
  }
  delete process.env.WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC;
});

test("THE TICK ITSELF honours the anchor — not just the status display", () => {
  // Without this the change is cosmetic: the tick had its own inline `elapsed < minGapMs` check and
  // never consulted computeNextFireAt at all.
  const lastRunAtMs = Date.parse("2027-03-04T03:00:00Z");
  const at = (iso: string) => shouldFireAt({ lastRunAtMs, nowMs: Date.parse(iso), anchorHourUtc: 12, minGapMs: 6 * H });
  assert.equal(at("2027-03-04T11:00:00Z"), false, "before the anchor: no run");
  assert.equal(at("2027-03-04T11:59:59Z"), false, "one second before the anchor: still no run");
  assert.equal(at("2027-03-04T12:00:01Z"), true, "at/after the anchor: run");
});
