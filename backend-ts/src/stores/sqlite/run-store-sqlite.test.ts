/**
 * Contract test: SqliteRunStore over a real @mieweb/cloud-local SQLite CloudDatabase (#103).
 * Proves the RunStore contract works on the portable floor — including the atomic
 * queue-claim — entirely in Node, no JVM. Run:
 *   node --import tsx --test src/stores/sqlite/run-store-sqlite.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./schema.ts";
import { SqliteRunStore } from "./run-store-sqlite.ts";
import type { CreateRunInput } from "../run-store.ts";

const dbPath = join(tmpdir(), `workwell-runstore-${crypto.randomUUID()}.sqlite`);
let store: SqliteRunStore;

const sampleInput = (scopeId?: string): CreateRunInput => ({
  scopeType: "MEASURE",
  scopeId,
  triggeredBy: "spike@workwell.dev",
  requestedScope: { measureId: scopeId ?? "audiogram" },
  measurementPeriodStart: "2025-06-12T00:00:00.000Z",
  measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
});

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  store = new SqliteRunStore(db);
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("createRun inserts a QUEUED run and getRun reads it back", async () => {
  const created = await store.createRun(sampleInput("audiogram"));
  assert.equal(created.status, "QUEUED");
  assert.equal(created.scopeType, "MEASURE");
  assert.ok(created.id);
  assert.equal(created.completedAt, null);

  const fetched = await store.getRun(created.id);
  assert.deepEqual(fetched, created);
});

test("getRun returns null for an unknown id", async () => {
  assert.equal(await store.getRun(crypto.randomUUID()), null);
});

test("appendLog writes without error", async () => {
  const run = await store.createRun(sampleInput());
  await store.appendLog(run.id, "INFO", "run started");
  await store.appendLog(run.id, "INFO", "evaluated 1 employee");
  // (read-back of logs is a separate contract method; insert success is the assertion here)
});

test("claimNextQueuedRun atomically flips QUEUED → RUNNING, FIFO, then null", async () => {
  // Fresh store so prior tests' rows don't interfere with ordering assertions.
  const db = await createSqliteD1(join(tmpdir(), `workwell-claim-${crypto.randomUUID()}.sqlite`));
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const s = new SqliteRunStore(db);

  const first = await s.createRun(sampleInput("first"));
  await new Promise((r) => setTimeout(r, 5)); // ensure distinct started_at ordering
  const second = await s.createRun(sampleInput("second"));

  const claim1 = await s.claimNextQueuedRun("worker-A");
  assert.equal(claim1?.id, first.id, "oldest QUEUED run is claimed first");
  assert.equal(claim1?.status, "RUNNING");

  const claim2 = await s.claimNextQueuedRun("worker-B");
  assert.equal(claim2?.id, second.id);
  assert.equal(claim2?.status, "RUNNING");

  // No QUEUED rows left → null (already-claimed runs are not re-claimed).
  assert.equal(await s.claimNextQueuedRun("worker-C"), null);
});

test("markRunning moves a QUEUED run out of the claim path (idempotent)", async () => {
  const db = await createSqliteD1(join(tmpdir(), `workwell-mark-${crypto.randomUUID()}.sqlite`));
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const s = new SqliteRunStore(db);

  const run = await s.createRun(sampleInput());
  const running = await s.markRunning(run.id);
  assert.equal(running?.status, "RUNNING");
  assert.equal(await s.claimNextQueuedRun("worker-X"), null, "a RUNNING run is not claimable");
  assert.equal((await s.markRunning(run.id))?.status, "RUNNING", "idempotent");
});
