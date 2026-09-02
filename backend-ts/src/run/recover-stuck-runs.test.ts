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
import { recoverStuckRuns } from "./recover-stuck-runs.ts";

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
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  const events = new SqliteCaseEventStore(db);
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

    const recovered = await recoverStuckRuns({ runs, events }, 0);
    assert.equal(recovered.length, 2, "still returns every recovered run");
    assert.equal((await runs.getRun(run1.id))?.status, "FAILED");
    assert.equal((await runs.getRun(run2.id))?.status, "FAILED");

    const run1Audits = (await events.auditEventsByRun(run1.id)).filter((a) => a.eventType === "RUN_RECOVERED");
    const run2Audits = (await events.auditEventsByRun(run2.id)).filter((a) => a.eventType === "RUN_RECOVERED");

    assert.equal(run1Audits.length, 0, "first run audit failed due to simulated error");
    assert.equal(run2Audits.length, 1, "second run still gets its audit event despite first failure");
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
