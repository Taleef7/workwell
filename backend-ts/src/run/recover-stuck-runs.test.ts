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
import { recoverStuckRuns } from "./recover-stuck-runs.ts";

const sampleRun = (): CreateRunInput => ({
  scopeType: "ALL_PROGRAMS",
  triggeredBy: "test",
  requestedScope: {},
  measurementPeriodStart: "2026-06-17T00:00:00.000Z",
  measurementPeriodEnd: "2026-06-17T00:00:00.000Z",
});

test("recoverStuckRuns fails stuck RUNNING/QUEUED runs AND writes a RUN_RECOVERED audit per run", async () => {
  const dbPath = join(tmpdir(), `workwell-recover-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  const events = new SqliteCaseEventStore(db);
  try {
    const running = await runs.createRun(sampleRun());
    await runs.markRunning(running.id); // QUEUED → RUNNING
    const queued = await runs.createRun(sampleRun()); // stays QUEUED
    const done = await runs.createRun(sampleRun());
    await runs.finalizeRun(done.id, "COMPLETED"); // terminal — must be left alone + not audited

    await new Promise((r) => setTimeout(r, 10)); // ensure started_at precedes the threshold-0 cutoff
    const recovered = await recoverStuckRuns({ runs, events }, 0);

    assert.equal(recovered.length, 2, "the RUNNING + QUEUED runs are recovered");
    assert.equal((await runs.getRun(running.id))?.status, "FAILED");
    assert.equal((await runs.getRun(queued.id))?.status, "FAILED");
    assert.equal((await runs.getRun(done.id))?.status, "COMPLETED", "terminal run untouched");

    // Every recovery is audited (the hard rule). The terminal run gets no recovery audit.
    for (const id of [running.id, queued.id]) {
      const audits = await events.auditEventsByRun(id);
      assert.ok(
        audits.some((a) => a.eventType === "RUN_RECOVERED"),
        `run ${id} has a RUN_RECOVERED audit event`,
      );
    }
    assert.equal(
      (await events.auditEventsByRun(done.id)).filter((a) => a.eventType === "RUN_RECOVERED").length,
      0,
      "the COMPLETED run is not audited as recovered",
    );
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});
