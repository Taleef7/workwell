/**
 * Backend-agnostic store contract suite (#104).
 *
 * The whole point of the ports/adapters split is that one contract holds on every
 * backend. So rather than test SQLite and Postgres separately, both adapters run
 * THIS suite — the floor (`UPDATE … RETURNING`) and the ceiling (`FOR UPDATE SKIP
 * LOCKED`) must produce identical observable behaviour. Each `freshStore*` factory
 * hands back an isolated, empty store so ordering assertions are deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CreateRunInput, RunStore } from "./run-store.ts";
import type { OutcomeStore } from "./outcome-store.ts";

export const sampleRun = (scopeId?: string): CreateRunInput => ({
  scopeType: "MEASURE",
  scopeId,
  triggeredBy: "spike@workwell.dev",
  requestedScope: { measureId: scopeId ?? "audiogram" },
  measurementPeriodStart: "2025-06-12T00:00:00.000Z",
  measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
});

/** Registers the RunStore contract for one backend. `freshStore` → isolated, empty. */
export function runStoreContract(label: string, freshStore: () => Promise<RunStore>): void {
  test(`[${label}] createRun inserts a QUEUED run and getRun reads it back`, async () => {
    const store = await freshStore();
    const created = await store.createRun(sampleRun("audiogram"));
    assert.equal(created.status, "QUEUED");
    assert.equal(created.scopeType, "MEASURE");
    assert.equal(created.scopeId, "audiogram");
    assert.ok(created.id);
    assert.equal(created.completedAt, null);

    const fetched = await store.getRun(created.id);
    assert.deepEqual(fetched, created);
  });

  test(`[${label}] getRun returns null for an unknown id`, async () => {
    const store = await freshStore();
    assert.equal(await store.getRun(crypto.randomUUID()), null);
  });

  test(`[${label}] getRun/markRunning return null for a malformed (non-UUID) id`, async () => {
    // The Postgres ceiling has native UUID id columns; a malformed id (e.g. `foo`
    // from GET /api/runs/foo) must NOT throw — it must match the floor's "no row".
    const store = await freshStore();
    assert.equal(await store.getRun("not-a-uuid"), null);
    assert.equal(await store.markRunning("not-a-uuid"), null);
  });

  test(`[${label}] appendLog writes, listLogs reads them back oldest-first`, async () => {
    const store = await freshStore();
    const run = await store.createRun(sampleRun());
    await store.appendLog(run.id, "INFO", "run started");
    await store.appendLog(run.id, "WARN", "evaluated 1 employee");
    const logs = await store.listLogs(run.id);
    assert.equal(logs.length, 2);
    assert.deepEqual(
      logs.map((l) => `${l.level}:${l.message}`),
      ["INFO:run started", "WARN:evaluated 1 employee"],
    );
    assert.ok(logs[0]!.ts, "log carries a timestamp");
  });

  test(`[${label}] listRuns returns runs newest-first, capped at limit`, async () => {
    const store = await freshStore();
    const a = await store.createRun(sampleRun("a"));
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.createRun(sampleRun("b"));
    const all = await store.listRuns();
    assert.deepEqual(
      all.map((r) => r.id),
      [b.id, a.id],
      "newest started_at first",
    );
    assert.equal((await store.listRuns(1)).length, 1, "respects the limit");
  });

  test(`[${label}] claimNextQueuedRun atomically flips QUEUED → RUNNING, FIFO, then null`, async () => {
    const store = await freshStore();
    const first = await store.createRun(sampleRun("first"));
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct started_at ordering
    const second = await store.createRun(sampleRun("second"));

    const claim1 = await store.claimNextQueuedRun("worker-A");
    assert.equal(claim1?.id, first.id, "oldest QUEUED run is claimed first");
    assert.equal(claim1?.status, "RUNNING");

    const claim2 = await store.claimNextQueuedRun("worker-B");
    assert.equal(claim2?.id, second.id);
    assert.equal(claim2?.status, "RUNNING");

    assert.equal(await store.claimNextQueuedRun("worker-C"), null, "no QUEUED rows left");
  });

  test(`[${label}] concurrent claims hand each worker a distinct run (no double-claim)`, async () => {
    const store = await freshStore();
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await store.createRun(sampleRun(`run-${i}`)));
      await new Promise((r) => setTimeout(r, 2));
    }
    // Fire all claims at once: each worker must get a different run, none repeated.
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.claimNextQueuedRun(`worker-${i}`)),
    );
    const ids = claims.map((c) => c?.id);
    assert.equal(new Set(ids).size, 5, "every claim is a distinct run id");
    assert.deepEqual([...ids].sort(), made.map((m) => m.id).sort());
    assert.equal(await store.claimNextQueuedRun("worker-late"), null);
  });

  test(`[${label}] markRunning moves a QUEUED run out of the claim path (idempotent)`, async () => {
    const store = await freshStore();
    const run = await store.createRun(sampleRun());
    const running = await store.markRunning(run.id);
    assert.equal(running?.status, "RUNNING");
    assert.equal(await store.claimNextQueuedRun("worker-X"), null, "a RUNNING run is not claimable");
    assert.equal((await store.markRunning(run.id))?.status, "RUNNING", "idempotent");
  });
}

/** Registers the OutcomeStore contract. `fresh` → isolated, empty {run, outcome} pair. */
export function outcomeStoreContract(
  label: string,
  fresh: () => Promise<{ runStore: RunStore; outcomeStore: OutcomeStore }>,
): void {
  test(`[${label}] recordOutcome persists and listOutcomes reads it back with evidence intact`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun("audiogram"));
    const evidence = { expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] };

    const rec = await outcomeStore.recordOutcome({
      runId: run.id,
      subjectId: "emp-006",
      measureId: "audiogram",
      status: "OVERDUE",
      evidence,
    });
    assert.ok(rec.id);
    assert.equal(rec.status, "OVERDUE");

    const listed = await outcomeStore.listOutcomes(run.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.subjectId, "emp-006");
    assert.equal(listed[0]!.status, "OVERDUE");
    assert.deepEqual(listed[0]!.evidence, evidence, "JSON evidence round-trips identically");
  });

  test(`[${label}] listOutcomes returns [] for a run with no outcomes`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun());
    assert.deepEqual(await outcomeStore.listOutcomes(run.id), []);
  });

  test(`[${label}] listOutcomes returns [] for a malformed (non-UUID) run id`, async () => {
    const { outcomeStore } = await fresh();
    assert.deepEqual(await outcomeStore.listOutcomes("not-a-uuid"), []);
  });
}
