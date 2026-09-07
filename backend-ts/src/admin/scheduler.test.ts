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

test("a restart does not re-fire a day whose anchor has already been served", async () => {
  // Rewritten for the anchor rule. The old version started the prior run at 00:00 and asserted that a
  // tick 23 h later stayed skipped — a 23.5-hour cooldown. Under "one scheduled run per UTC day at the
  // anchor" the meaningful question is different: a run that already served its day's anchor must not
  // fire again that day, however many times the process restarts.
  const stores = await freshStores();
  const startedAt = "2026-07-01T12:00:00.000Z"; // the day's anchor, served
  await createPriorSchedulerRun(stores, startedAt);

  setSchedulerEnabled(true);
  setSchedulerEnabled(true); // simulated process restart: enabled state is re-initialized
  const fired = await runTick(deps(stores), Date.parse("2026-07-01T23:00:00.000Z"));

  assert.equal(fired, false, "this day's anchor was already served — a restart must not re-run it");
  assert.equal((await schedulerTriggerEvents(stores)).length, 0, "skipped tick must not write an audit event");
});

test("the tick fires at the ANCHOR, not when 24 hours have elapsed", async () => {
  // A run that served the 2026-07-01 anchor is next due at the 2026-07-02 anchor — not 24 h after
  // whenever it happened to start. The cadence version of this asserted that 24 h + 1 ms fires
  // immediately, which is what let a late run drag every later one with it.
  const stores = await freshStores();
  await createPriorSchedulerRun(stores, "2026-07-01T12:00:00.000Z");

  setSchedulerEnabled(true);
  assert.equal(await runTick(deps(stores), Date.parse("2026-07-02T11:59:59.000Z")), false, "one second before the anchor");
  assert.equal((await schedulerTriggerEvents(stores)).length, 0);

  assert.equal(await runTick(deps(stores), Date.parse("2026-07-02T12:00:00.000Z")), true, "at the anchor");
  assert.equal((await schedulerTriggerEvents(stores)).length, 1, "a fired run must write its scheduler audit event");
});

test("a run that fired BEFORE its day's anchor, inside the debounce, has SERVED that day", async () => {
  // The first run after enabling the scheduler fires immediately at whatever the wall clock is. The
  // previous version of this test then had the 12:00 anchor fire as well — "one extra, idempotent run
  // on day one" — while the function's header, DEPLOY.md and the tick's own `minGapMs` argument all
  // described a 23.5 h floor that nothing read (Codex review, #528). The floor applies to today's
  // anchor only, so day one gets its recompute at 03:00 and the next at tomorrow's anchor; no night is
  // skipped, and a 20,000-patient run is not repeated nine hours later for the same data.
  const stores = await freshStores();
  await createPriorSchedulerRun(stores, "2026-07-01T03:00:00.000Z");

  setSchedulerEnabled(true);
  assert.equal(await runTick(deps(stores), Date.parse("2026-07-01T12:00:00.000Z")), false, "today's anchor is inside the debounce of the 03:00 run");
  assert.equal(await runTick(deps(stores), Date.parse("2026-07-02T12:00:00.000Z")), true, "tomorrow's anchor fires");
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
  assert.equal(fired, false, "09:00 is not the anchor");

  // The tick learned when the next run is due, so intervening ticks cost zero DB round trips. The
  // cached instant is the ANCHOR — the same rule the tick and the display use — so the cache and the
  // decision cannot disagree about when the nightly run happens. The 06:00 run served this day (it is
  // inside the debounce of the 12:00 anchor), so the cached due instant is TOMORROW's anchor.
  assert.equal(shouldSkipTickWithoutDb(base + 4 * 3_600_000), true);
  assert.equal(shouldSkipTickWithoutDb(base + 6 * 3_600_000), true, "this day's 12:00 is served by the 06:00 run");
  assert.equal(shouldSkipTickWithoutDb(base + 29.9 * 3_600_000), true);

  // ...and it stops skipping at tomorrow's anchor, so the schedule is preserved.
  assert.equal(shouldSkipTickWithoutDb(base + 30 * 3_600_000), false, "06:00 + 30 h = tomorrow's 12:00 anchor");
});

test("after a fired tick, later ticks skip the DB until the next cycle is due", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  const now = Date.UTC(2026, 6, 1, 6, 0, 0);

  const fired = await runTick(deps(stores), now);
  assert.equal(fired, true, "no prior scheduler run — the first enabled tick fires");

  assert.equal(shouldSkipTickWithoutDb(now + 3_600_000), true, "07:00 — nothing is due");
  assert.equal(shouldSkipTickWithoutDb(now + 6 * 3_600_000), true, "12:00 — this day's anchor was served by the 06:00 run");
  assert.equal(shouldSkipTickWithoutDb(now + 30 * 3_600_000), false, "06:00 + 30 h = tomorrow's 12:00 anchor");
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

test("a run EARLIER on the anchor's own day, inside the debounce, has SERVED that day — the next fire is tomorrow's anchor", () => {
  // The previous version of this test pinned the opposite: "a run at 11:00 leaves 12:00 owed and it
  // fires an hour later — firing twice in a day is cheap". It is not cheap on a 20,000-patient roster,
  // and the function's own header, DEPLOY.md and the tick's `minGapMs` argument all said the floor
  // existed while nothing read it (Codex review, #528). The floor applies to today's anchor only, so
  // this cannot re-introduce the night-skip below: tomorrow's anchor is never pushed.
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T11:00:00Z"), nowMs: Date.parse("2027-03-04T11:05:00Z"), anchorHourUtc: 12 }),
    "2027-03-05T12:00:00.000Z",
  );
  // The case Codex named: enabled at 11:59, first run fires at once; the 12:00 anchor must NOT fire a
  // minute later — and the tick agrees with the display.
  const enabledAt = Date.parse("2027-03-04T11:59:00Z");
  assert.equal(shouldFireAt({ lastRunAtMs: enabledAt, nowMs: Date.parse("2027-03-04T12:00:30Z"), anchorHourUtc: 12 }), false, "no second run one minute later");
  assert.equal(shouldFireAt({ lastRunAtMs: enabledAt, nowMs: Date.parse("2027-03-05T12:00:00Z"), anchorHourUtc: 12 }), true, "tomorrow's anchor fires");
  // But a same-day run OUTSIDE the debounce still leaves the day owed: a 6 h floor with a 03:00 run.
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T03:00:00Z"), nowMs: Date.parse("2027-03-04T03:05:00Z"), anchorHourUtc: 12, minGapMs: 6 * H }),
    "2027-03-04T12:00:00.000Z",
  );
});

test("NO DAY IS EVER SKIPPED, whatever hour the last run started", () => {
  // The regression this file exists for. Every one of these produced 44-47.5 hours under the floor,
  // with the intervening night silently lost — and the commonest trigger is the most ordinary: the
  // first run after a working-hours deploy fires at whatever the wall clock is.
  for (const [last, expected] of [
    ["2027-03-04T12:00:05Z", "2027-03-05T12:00:00.000Z"],
    ["2027-03-04T12:30:01Z", "2027-03-05T12:00:00.000Z"],
    ["2027-03-04T15:00:00Z", "2027-03-05T12:00:00.000Z"],
    ["2027-03-04T23:59:59Z", "2027-03-05T12:00:00.000Z"],
  ] as const) {
    const next = computeNextFireAt({ lastRunAtMs: Date.parse(last), nowMs: Date.parse(last) + 60_000, anchorHourUtc: 12 });
    assert.equal(next, expected, `last run ${last}`);
    const gapHours = (Date.parse(next) - Date.parse(last)) / 3_600_000;
    assert.ok(gapHours <= 24, `${last} -> ${next} is ${gapHours.toFixed(1)}h — a night was skipped`);
    // And the tick agrees: it fires once that anchor arrives.
    assert.equal(shouldFireAt({ lastRunAtMs: Date.parse(last), nowMs: Date.parse(expected), anchorHourUtc: 12 }), true, last);
  }
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
  // Ran four hours past the anchor; the next fire is the NEXT day's anchor, 20 hours later. The
  // previous version of this test asserted 2027-03-06 — a 44-hour gap — and so pinned the day-skip as
  // correct under a name that says the opposite. That is the shape this project calls a vacuous guard.
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T16:00:00Z"), nowMs: Date.parse("2027-03-04T16:01:00Z"), anchorHourUtc: 12 }),
    "2027-03-05T12:00:00.000Z",
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

// ── Retention runs after the run, and only when configured (ADR-073) ─────────
//
// `outcome-compaction.ts` says "The scheduler enforces the order; outcome-compaction.test.ts pins it"
// and that file's header claimed to prove it runs after the quality snapshot. Neither was true: no test
// imported both, so deleting the `compactOutcomes` call from the tick — or moving it ABOVE the run,
// which is the ordering that destroys the durable history the whole design rests on — left the suite
// green. These are that enforcement.

test("a scheduled run triggers a retention pass, AFTER the run has finished", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  process.env.WORKWELL_OUTCOME_RETENTION_DAYS = "90";
  const order: string[] = [];
  const base = deps(stores);
  const instrumented = {
    ...base,
    stores: {
      ...base.stores,
      outcomes: new Proxy(base.stores.outcomes, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "compactOlderThan" && typeof value === "function") {
            return async (...args: unknown[]) => {
              order.push("compact");
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          if (prop === "recordOutcomes" && typeof value === "function") {
            return async (...args: unknown[]) => {
              order.push("persist");
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    },
  };
  try {
    const fired = await runTick(instrumented as never, Date.UTC(2026, 6, 1, 12, 0, 0));
    assert.equal(fired, true);
    assert.ok(order.includes("compact"), "the tick must run a retention pass when retention is configured");
    // Compaction after the last persist — i.e. after the run and its snapshot, never before. Compacting
    // first would delete the per-subject rows the aggregate is computed from, and that loss is permanent.
    assert.equal(order.at(-1), "compact", `order was ${order.join(" -> ")}`);
    assert.ok(order.indexOf("persist") < order.indexOf("compact"), "a chunk was persisted before compaction ran");
  } finally {
    delete process.env.WORKWELL_OUTCOME_RETENTION_DAYS;
  }
});

test("with retention unset the tick compacts NOTHING — the default deployment never loses a row", async () => {
  const stores = await freshStores();
  setSchedulerEnabled(true);
  delete process.env.WORKWELL_OUTCOME_RETENTION_DAYS;
  let compactions = 0;
  const base = deps(stores);
  const instrumented = {
    ...base,
    stores: {
      ...base.stores,
      outcomes: new Proxy(base.stores.outcomes, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "compactOlderThan" && typeof value === "function") {
            return async (...args: unknown[]) => {
              compactions += 1;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    },
  };
  assert.equal(await runTick(instrumented as never, Date.UTC(2026, 6, 1, 12, 0, 0)), true);
  assert.equal(compactions, 0);
});
