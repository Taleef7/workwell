/**
 * Boot recovery audits every recovered run (#109). The "every state change is audited" hard rule
 * applies to the RUNNING/QUEUED → FAILED recovery just like any other mutation.
 * node --import tsx --test src/run/recover-stuck-runs.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import type { CreateRunInput } from "../stores/run-store.ts";
import type { AlertChannel, RunAlert } from "./alert-channel.ts";
import { recoverStuckRuns, orphanThresholdMs, bootInstant } from "./recover-stuck-runs.ts";

/** Captured at module load, to prove the production boot instant precedes it (see the last test). */
const TEST_MODULE_LOADED_AT = Date.now();
/** Mirrors CUTOFF_MARGIN_MS; kept local so the test states the value it expects rather than importing it. */
const CUTOFF_MARGIN_MS_FOR_TEST = 1000;

const sampleRun = (): CreateRunInput => ({
  scopeType: "ALL_PROGRAMS",
  triggeredBy: "test",
  requestedScope: {},
  measurementPeriodStart: "2026-06-17T00:00:00.000Z",
  measurementPeriodEnd: "2026-06-17T00:00:00.000Z",
});

test("recoverStuckRuns fails stuck RUNNING and unclaimed QUEUED runs AND writes a distinct RUN_RECOVERED audit per run", async () => {
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  const events = new SqliteCaseEventStore(db);
  const capturedAlerts: RunAlert[] = [];
  const alertChannels: AlertChannel[] = [
    {
      name: "capturing",
      async send(alert) {
        capturedAlerts.push(alert);
      },
    },
  ];
  try {
    const running = await runs.createRun(sampleRun());
    await runs.markRunning(running.id); // QUEUED → RUNNING (the orphaned-async-run case)
    const queued = await runs.createRun(sampleRun()); // stays QUEUED — claim-path pending work
    const done = await runs.createRun(sampleRun());
    await runs.finalizeRun(done.id, "COMPLETED"); // terminal

    await new Promise((r) => setTimeout(r, 10)); // ensure started_at precedes the threshold-0 cutoff
    // With olderThanMs = 0 and default queued threshold: only RUNNING is recovered.
    const recoveredRunning = await recoverStuckRuns({ runs, events, alertChannels }, 0);

    assert.deepEqual(
      recoveredRunning,
      [{ id: running.id, previousStatus: "RUNNING" }],
      "only the RUNNING run is recovered when queued threshold is not exceeded",
    );
    assert.equal((await runs.getRun(running.id))?.status, "FAILED");
    assert.equal((await runs.getRun(queued.id))?.status, "QUEUED", "QUEUED is retained when below queued threshold");
    assert.equal((await runs.getRun(done.id))?.status, "COMPLETED", "terminal run untouched");

    // With unclaimedQueuedOlderThanMs = 0: unclaimed QUEUED is also recovered.
    const recoveredQueued = await recoverStuckRuns({ runs, events, alertChannels }, 0, 0);
    assert.deepEqual(
      recoveredQueued,
      [{ id: queued.id, previousStatus: "QUEUED" }],
      "unclaimed QUEUED run is recovered when exceeding queued threshold",
    );
    assert.equal((await runs.getRun(queued.id))?.status, "FAILED");

    // Both recoveries are audited with distinct reasons — assert EXACTLY one per recovered run.
    const runningAudits = (await events.auditEventsByRun(running.id)).filter((a) => a.eventType === "RUN_RECOVERED");
    const queuedAudits = (await events.auditEventsByRun(queued.id)).filter((a) => a.eventType === "RUN_RECOVERED");
    const doneAudits = (await events.auditEventsByRun(done.id)).filter((a) => a.eventType === "RUN_RECOVERED");

    assert.equal(runningAudits.length, 1, "exactly one RUN_RECOVERED audit event for RUNNING run");
    assert.match(
      (runningAudits[0]!.payload as { reason: string }).reason,
      /restart/i,
      "RUNNING recovery reason mentions container restart",
    );

    assert.equal(queuedAudits.length, 1, "exactly one RUN_RECOVERED audit event for QUEUED run");
    assert.match(
      (queuedAudits[0]!.payload as { reason: string }).reason,
      /queued/i,
      "QUEUED recovery reason mentions queued / worker timeout",
    );

    assert.equal(doneAudits.length, 0, `terminal run ${done.id} is not audited as recovered`);

    // Alert assertions: exactly one alert per recovered run distinguishing QUEUED from RUNNING.
    assert.equal(capturedAlerts.length, 2, "exactly one alert per recovered run");
    const runningAlerts = capturedAlerts.filter((a) => a.runId === running.id);
    assert.equal(runningAlerts.length, 1, "exactly one alert for RUNNING run");
    assert.equal(runningAlerts[0]!.kind, "RUN_RECOVERED");
    assert.match(runningAlerts[0]!.message, /restart/i, "RUNNING alert message mentions container restart");

    const queuedAlerts = capturedAlerts.filter((a) => a.runId === queued.id);
    assert.equal(queuedAlerts.length, 1, "exactly one alert for QUEUED run");
    assert.equal(queuedAlerts[0]!.kind, "RUN_RECOVERED");
    assert.match(queuedAlerts[0]!.message, /queued/i, "QUEUED alert message mentions queued timeout");

    assert.equal(capturedAlerts.filter((a) => a.runId === done.id).length, 0, "no alert for terminal run");
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("recoverStuckRuns continues audit loop if appendAudit fails for a run (best-effort per run)", async () => {
  // Mutation note: Removing the restoreRecoveredRun compensation call causes run1 to remain FAILED
  // with completed_at set, leaves run1 in the returned recovered list, and omits the restore mention in its alert.
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  const events = new SqliteCaseEventStore(db);
  const capturedAlerts: RunAlert[] = [];
  const alertChannels: AlertChannel[] = [
    {
      name: "capturing",
      async send(alert) {
        capturedAlerts.push(alert);
      },
    },
  ];
  try {
    const run1 = await runs.createRun(sampleRun());
    await runs.markRunning(run1.id);
    const run2 = await runs.createRun(sampleRun());
    await runs.markRunning(run2.id);

    await new Promise((r) => setTimeout(r, 10));

    let auditAttempts = 0;
    const originalAppendAudit = events.appendAudit.bind(events);
    events.appendAudit = async (event) => {
      auditAttempts++;
      if (auditAttempts === 1) {
        throw new Error("simulated transient audit DB failure");
      }
      return originalAppendAudit(event);
    };

    const recovered = await recoverStuckRuns({ runs, events, alertChannels }, 0);
    // run1 audit failed -> compensated with restoreRecoveredRun -> excluded from returned list
    assert.deepEqual(
      recovered,
      [{ id: run2.id, previousStatus: "RUNNING" }],
      "first run is absent from returned list; only successfully recovered runs returned",
    );

    // run1 is restored to its previous status (RUNNING) with completed_at null
    const run1Record = await runs.getRun(run1.id);
    assert.equal(run1Record?.status, "RUNNING", "first run is back to its previous status");
    assert.equal(run1Record?.completedAt, null, "first run has completed_at null");

    // run2 is FAILED with completed_at stamped
    const run2Record = await runs.getRun(run2.id);
    assert.equal(run2Record?.status, "FAILED", "second run is recovered as FAILED");
    assert.ok(run2Record?.completedAt, "second run has completed_at set");

    const run1Audits = (await events.auditEventsByRun(run1.id)).filter((a) => a.eventType === "RUN_RECOVERED");
    const run2Audits = (await events.auditEventsByRun(run2.id)).filter((a) => a.eventType === "RUN_RECOVERED");

    assert.equal(run1Audits.length, 0, "first run audit failed due to simulated error");
    assert.equal(run2Audits.length, 1, "second run still gets its audit event despite first failure");

    // Alert assertions: run1 alert message mentions the restore
    const run1Alerts = capturedAlerts.filter((a) => a.runId === run1.id);
    assert.equal(run1Alerts.length, 1, "first run still emitted an alert");
    assert.match(run1Alerts[0]!.message, /restore/i, "first run alert message mentions the restore");

    const run2Alerts = capturedAlerts.filter((a) => a.runId === run2.id);
    assert.equal(run2Alerts.length, 1, "second run emitted normal recovery alert");
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("Fable M7: a backdated RUNNING seed:scale run is NOT swept (its started_at is old by design)", async () => {
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  const events = new SqliteCaseEventStore(db);
  try {
    // A seed CLI creates a RUNNING run backdated far into the past (started_at = --as-of).
    const seed = await runs.createRun({ ...sampleRun(), triggeredBy: "seed:scale", status: "RUNNING", startedAt: "2026-06-26T00:00:00.000Z" });
    // A genuine orphan created RUNNING now.
    const orphan = await runs.createRun(sampleRun());
    await runs.markRunning(orphan.id);
    await new Promise((r) => setTimeout(r, 10));

    const recovered = await recoverStuckRuns({ runs, events }, 0);
    assert.deepEqual(recovered, [{ id: orphan.id, previousStatus: "RUNNING" }], "only the real orphan is recovered; the seed run is skipped");
    assert.equal((await runs.getRun(seed.id))?.status, "RUNNING", "the seed run is left RUNNING for its CLI to finalize");
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("Fable M15: finalizeRun does not resurrect a run already FAILED by the sweep", async () => {
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  try {
    const r = await runs.createRun(sampleRun());
    await runs.markRunning(r.id);
    await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(await runs.failStuckRuns(0), [{ id: r.id, previousStatus: "RUNNING" }]); // swept → FAILED
    // A late in-flight completion must NOT overwrite the FAILED verdict (terminal-status guard).
    await runs.finalizeRun(r.id, "COMPLETED");
    assert.equal((await runs.getRun(r.id))?.status, "FAILED", "terminal FAILED is preserved");
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Drive `recoverStuckRuns` against the real SQLite store with NO explicit threshold, so the wiring's
 * default (`orphanThresholdMs`) is what decides. Returns the ids it recovered plus each run's status.
 */
async function sweepWith(
  bootedAt: number,
  runsToCreate: readonly { label: string; startedAt: number }[],
): Promise<{ recovered: string[]; statusOf: Record<string, string | undefined> }> {
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  const events = new SqliteCaseEventStore(db);
  try {
    const ids = new Map<string, string>();
    for (const r of runsToCreate) {
      const created = await runs.createRun({ ...sampleRun(), startedAt: new Date(r.startedAt).toISOString() });
      await runs.markRunning(created.id); // QUEUED → RUNNING, leaving claimed_by NULL as the real path does
      ids.set(r.label, created.id);
    }
    const recovered = await recoverStuckRuns({ runs, events, bootedAt });
    const statusOf: Record<string, string | undefined> = {};
    for (const [label, id] of ids) statusOf[label] = (await runs.getRun(id))?.status;
    const labelOf = new Map([...ids].map(([label, id]) => [id, label]));
    return { recovered: recovered.map((r) => labelOf.get(r.id) ?? r.id), statusOf };
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// The two halves of the 2026-09-09 incident need OPPOSITE fixtures — demonstrating that the flat
// 30-minute default misses a young orphan requires a recent boot, and that it kills a healthy long
// run requires an old one — so they cannot share a test. The previous single test used a 45-minute-old
// boot with a 55-minute-old orphan, which the flat default would ALSO have swept: it failed on revert
// only because the live run died too, and its comment claimed a mechanism it did not test.

test("a run created BEFORE boot is swept even when it is far younger than the old flat threshold", async () => {
  // The deploy-mid-run case, and the one the flat 30-minute default provably missed: the orphan is
  // 25 minutes old, so `failStuckRuns`'s own default would leave it RUNNING for ever (both triggers
  // are one-shot per process). Reverting the wiring to `failStuckRuns(olderThanMs, …)` fails here.
  const bootedAt = Date.now() - 20 * 60 * 1000;
  const { recovered, statusOf } = await sweepWith(bootedAt, [
    { label: "orphan", startedAt: bootedAt - 5 * 60 * 1000 }, // 25 min old — under the flat 30 min
  ]);
  assert.deepEqual(recovered, ["orphan"], "a pre-boot run is orphaned at ANY age, not only past 30 minutes");
  assert.equal(statusOf.orphan, "FAILED");
});

test("a run created AFTER boot survives however long it has been running", async () => {
  // The half that broke the pilot: an 88-minute nightly is healthy, and the flat 30-minute default
  // failed it at 98.7% complete. Setting CUTOFF_MARGIN_MS or the age term so the cutoff lands after
  // boot fails here.
  const bootedAt = Date.now() - 90 * 60 * 1000;
  const { recovered, statusOf } = await sweepWith(bootedAt, [
    { label: "live", startedAt: bootedAt + 2 * 60 * 1000 }, // 88 min old, started after boot
  ]);
  assert.deepEqual(recovered, [], "a long-running LIVE run is never swept");
  assert.equal(statusOf.live, "RUNNING");
});

test("the cutoff sits BEFORE boot by the full margin, not at boot and not after it", async () => {
  // Pins the margin's SIGN and its MAGNITUDE. An earlier version only placed a run 200ms after boot,
  // which left `CUTOFF_MARGIN_MS = 0` (and anything up to 199) green — the cutoff exactly at boot,
  // with no absorption at all for the gap between computing the threshold and the store applying it
  // against its own clock. `withinMargin` sits 500ms BEFORE boot and must survive, which is only true
  // while the margin actually pushes the cutoff back past it.
  const bootedAt = Date.now() - 10 * 60 * 1000;
  const { recovered, statusOf } = await sweepWith(bootedAt, [
    { label: "justAfterBoot", startedAt: bootedAt + 200 },
    { label: "withinMargin", startedAt: bootedAt - 500 },
    { label: "beforeMargin", startedAt: bootedAt - 60 * 1000 },
  ]);
  assert.deepEqual(recovered, ["beforeMargin"], "only the run older than boot MINUS the margin is swept");
  assert.equal(statusOf.justAfterBoot, "RUNNING");
  assert.equal(statusOf.withinMargin, "RUNNING", "the margin must place the cutoff strictly before boot");
});

test("recoverStuckRuns with NO injected bootedAt uses this process's real boot", async () => {
  // The production signature. Every other store-driven test passes `bootedAt` in, so the wiring's
  // `deps.bootedAt` default — and with it the real `BOOTED_AT` — was never exercised end to end.
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  const events = new SqliteCaseEventStore(db);
  try {
    // The live run is placed just after the REAL boot instant rather than at `now`, and that is the
    // whole point of the test. A run created at `now` survives under any cutoff at or before now, so
    // it cannot tell the real boot from a substitute — `deps.bootedAt ?? Date.now()` (a cutoff one
    // second back) spares it too, and passed an earlier version of this test. A run sitting just
    // after boot is spared ONLY by a cutoff actually anchored to boot.
    //
    // That requires this process to have more uptime than the margin, or "just after boot" and "just
    // before now" are the same instant. Waited for explicitly so the discrimination is deterministic
    // rather than dependent on how long the suite happened to take to get here.
    while (process.uptime() * 1000 < 2 * CUTOFF_MARGIN_MS_FOR_TEST) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const realBoot = bootInstant(Date.now(), process.uptime());

    // Created an hour before this process existed: orphaned under the real boot instant.
    const orphan = await runs.createRun({ ...sampleRun(), startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    await runs.markRunning(orphan.id);
    // Created 100ms after this process booted — after boot, but further back than the margin.
    const live = await runs.createRun({ ...sampleRun(), startedAt: new Date(realBoot + 100).toISOString() });
    await runs.markRunning(live.id);

    const recovered = await recoverStuckRuns({ runs, events }); // no bootedAt, no threshold

    assert.deepEqual(recovered.map((r) => r.id), [orphan.id]);
    assert.equal((await runs.getRun(live.id))?.status, "RUNNING");
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("bootInstant subtracts uptime in SECONDS from a millisecond clock", async () => {
  // The arithmetic of `BOOTED_AT` itself, which no runtime assertion can pin precisely (a test's own
  // process has only a second or two of uptime, so a wrong sign or a seconds/milliseconds mix-up
  // lands within any tolerance loose enough not to be flaky). Extracted so it can be checked exactly.
  assert.equal(bootInstant(1_000_000, 30), 970_000, "30s of uptime is 30,000ms BEFORE now");
  assert.equal(bootInstant(1_000_000, 0), 1_000_000, "a just-started process booted now");
  assert.ok(bootInstant(1_000_000, 30) < 1_000_000, "boot is in the past, never the future");
});

test("a clock that moved BACKWARDS sweeps nothing, rather than sweeping everything", async () => {
  // The critical guard, and the only one whose failure is unbounded. `Math.max(0, …)` — the previous
  // clamp — turned a negative age into a threshold of 0, which makes the store's cutoff `Date.now()`
  // and matches EVERY unclaimed RUNNING row: the 2026-09-09 incident reproduced by an NTP step. The
  // fixture puts boot an hour in the future of `now`, which is what a backward step looks like.
  const bootedAt = Date.now() + 60 * 60 * 1000;
  const { recovered, statusOf } = await sweepWith(bootedAt, [
    { label: "live", startedAt: Date.now() - 5 * 60 * 1000 },
    { label: "old", startedAt: Date.now() - 10 * 60 * 60 * 1000 },
  ]);
  assert.deepEqual(recovered, [], "an untrustworthy clock must sweep NOTHING");
  assert.equal(statusOf.live, "RUNNING");
  assert.equal(statusOf.old, "RUNNING");
});

test("orphanThresholdMs with no arguments measures PROCESS start, not module load", async () => {
  // The production default `BOOTED_AT` is otherwise never evaluated under assertion, and a loose band
  // here is not enough: `const BOOTED_AT = Date.now()` at module load — the exact regression the
  // source comment warns about — lands within a few seconds of uptime and passes it.
  //
  // What separates the two is that this process necessarily spent time starting (node boot, tsx,
  // imports) BEFORE this module was loaded. So a correct boot instant is measurably earlier than the
  // moment this test file was evaluated; a module-load stamp is not.
  const uptimeMs = process.uptime() * 1000;
  const threshold = orphanThresholdMs();
  const derivedBoot = Date.now() - threshold + CUTOFF_MARGIN_MS_FOR_TEST;

  assert.ok(
    threshold >= uptimeMs - 50 && threshold <= uptimeMs + 5_000,
    `expected a threshold near this process's uptime (${Math.round(uptimeMs)}ms), got ${threshold}ms`,
  );
  assert.ok(
    derivedBoot <= TEST_MODULE_LOADED_AT - 50,
    `boot (${derivedBoot}) must precede this module's load (${TEST_MODULE_LOADED_AT}) by more than the ` +
      `50ms of startup that certainly elapsed; a module-load stamp would make them equal`,
  );
});
