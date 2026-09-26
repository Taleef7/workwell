/**
 * #644: the Run History list keeps a finished run's counts and reads the rest a few at a time.
 *   node --import tsx --test src/run/run-counts.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetRunOutcomeCounts, runOutcomeCounts, runOutcomeCountsFor } from "./run-counts.ts";
import { compactOutcomes } from "./outcome-compaction.ts";
import type { OutcomeStatusCount } from "../stores/outcome-store.ts";

const counted = (n: number): OutcomeStatusCount[] => [{ status: "COMPLIANT", count: n, latestEvaluatedAt: null }];

function countingStore() {
  const reads: string[] = [];
  return {
    reads,
    async countOutcomesByStatus(runId: string) {
      reads.push(runId);
      return counted(reads.length);
    },
  };
}

beforeEach(() => resetRunOutcomeCounts());

test("a finished run is counted once and then kept; a running run is counted every time (#644)", async () => {
  const store = countingStore();
  const done = { id: "r-done", status: "COMPLETED" };
  const running = { id: "r-live", status: "RUNNING" };
  const first = await runOutcomeCounts(store, done);
  assert.deepEqual(await runOutcomeCounts(store, done), first, "the second load is the kept answer");
  await runOutcomeCounts(store, running);
  await runOutcomeCounts(store, running);
  assert.deepEqual(store.reads, ["r-done", "r-live", "r-live"]);
});

test("every finished status is kept, whatever its case (#644)", async () => {
  const store = countingStore();
  for (const status of ["COMPLETED", "partial_failure", "FAILED", "CANCELLED"]) {
    await runOutcomeCounts(store, { id: status, status });
    await runOutcomeCounts(store, { id: status, status });
  }
  assert.equal(store.reads.length, 4, "one read per finished run");
});

test("a kept count does not expire: only a reset, or a restart, reads it again (2026-09-26)", async (t) => {
  // The ten-minute expiry this replaces made nearly every visit cold: 48.8 s for the first page on the
  // pilot. Mock time forward a day to show nothing time-based remains.
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const store = countingStore();
  const done = { id: "r-done", status: "COMPLETED" };
  await runOutcomeCounts(store, done);
  t.mock.timers.tick(24 * 60 * 60_000);
  await runOutcomeCounts(store, done);
  assert.equal(store.reads.length, 1, "still the kept answer a day later");
});

test("two loads asking for the same run at once share one read (2026-09-26)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reads: string[] = [];
  const store = {
    async countOutcomesByStatus(runId: string) {
      reads.push(runId);
      await gate;
      return counted(7);
    },
  };
  const done = { id: "r-done", status: "COMPLETED" };
  const a = runOutcomeCounts(store, done);
  const b = runOutcomeCounts(store, done);
  release();
  assert.deepEqual(await a, await b);
  assert.deepEqual(reads, ["r-done"], "one count, not one per load");
  await runOutcomeCounts(store, done);
  assert.equal(reads.length, 1, "and the shared answer is kept");
});

test("a finished run never joins a read that began while it was running (2026-09-26)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = countingStore();
  let calls = 0;
  const slow = {
    async countOutcomesByStatus(runId: string) {
      calls += 1;
      if (calls === 1) await gate; // the read begun while the run was running is still outstanding
      return store.countOutcomesByStatus(runId);
    },
  };
  const whileRunning = runOutcomeCounts(slow, { id: "r-1", status: "RUNNING" });
  const finishedLoad = runOutcomeCounts(slow, { id: "r-1", status: "COMPLETED" });
  release();
  await whileRunning;
  const onceFinished = await finishedLoad;
  assert.equal(calls, 2, "the finished load read for itself");
  assert.deepEqual(await runOutcomeCounts(slow, { id: "r-1", status: "COMPLETED" }), onceFinished, "and its answer is the kept one");
  assert.equal(calls, 2);
});

test("outcome compaction resets the kept counts, since it is what changes a finished run's rows (#644)", async () => {
  const store = countingStore();
  const done = { id: "r-done", status: "COMPLETED" };
  await runOutcomeCounts(store, done);
  await compactOutcomes(
    {
      outcomes: { compactOlderThan: async () => 0 } as never,
      events: { appendAudit: async () => {} } as never,
    },
    { retentionDays: 400, now: Date.parse("2026-09-25T00:00:00Z") },
  );
  await runOutcomeCounts(store, done);
  assert.equal(store.reads.length, 2, "counted again after compaction");
});

test("a list's counts come back in the runs' order with at most three queries in flight (#644)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const store = {
    async countOutcomesByStatus(runId: string) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5 + (runId.charCodeAt(runId.length - 1) % 3) * 5));
      inFlight -= 1;
      return counted(Number(runId.slice(2)));
    },
  };
  const runs = Array.from({ length: 10 }, (_, i) => ({ id: `r-${i}`, status: "RUNNING" }));
  const out = await runOutcomeCountsFor(store, runs);
  assert.deepEqual(out.map((c) => c[0]!.count), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "in the runs' order");
  assert.equal(maxInFlight, 3, "never the whole pool");
});

test("one failed count fails the whole list read, as the unbounded Promise.all did, and keeps nothing (#644 review)", async () => {
  const reads: string[] = [];
  const store = {
    async countOutcomesByStatus(runId: string) {
      reads.push(runId);
      if (runId === "r-2") throw new Error("statement timeout");
      return counted(1);
    },
  };
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `r-${i}`, status: "COMPLETED" }));
  await assert.rejects(() => runOutcomeCountsFor(store, runs), /statement timeout/);
  const before = reads.length;
  await runOutcomeCounts(store, { id: "r-2", status: "COMPLETED" }).catch(() => {});
  assert.equal(reads.length, before + 1, "the failed run's count was not kept");
});

test("a count that was in flight when compaction reset the counts is not kept (#709, Codex)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reads: string[] = [];
  const store = {
    async countOutcomesByStatus(runId: string) {
      reads.push(runId);
      if (reads.length === 1) await gate; // the first read saw the pre-compaction rows
      return counted(reads.length);
    },
  };
  const done = { id: "r-done", status: "COMPLETED" };
  const inFlight = runOutcomeCounts(store, done);
  resetRunOutcomeCounts(); // compaction lands while that read is outstanding
  const afterReset = runOutcomeCounts(store, done); // asked before the stale read has even returned
  release();
  await inFlight;
  await afterReset;
  assert.equal(reads.length, 2, "a load after the reset did not join the stale read");
  await runOutcomeCounts(store, done);
  assert.equal(reads.length, 2, "and the fresh read, not the stale one, is what was kept");
});

test("a count is kept only for the status it was read under (2026-09-26)", async () => {
  // Boot recovery can mark a run FAILED, then restore it for a retry when its audit write fails.
  const store = countingStore();
  await runOutcomeCounts(store, { id: "r-1", status: "FAILED" });
  const final = await runOutcomeCounts(store, { id: "r-1", status: "COMPLETED" });
  assert.equal(store.reads.length, 2, "the run that finished for real is counted again");
  assert.equal(final[0]!.count, 2);
  assert.deepEqual(await runOutcomeCounts(store, { id: "r-1", status: "completed" }), final, "whatever the status's case");
  assert.equal(store.reads.length, 2);
});
