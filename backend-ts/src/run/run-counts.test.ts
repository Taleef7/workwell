/**
 * #644: the Run History list keeps a finished run's counts and reads the rest a few at a time.
 *   node --import tsx --test src/run/run-counts.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { COUNTS_TTL_MS, resetRunOutcomeCounts, runOutcomeCounts, runOutcomeCountsFor } from "./run-counts.ts";
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
  const first = await runOutcomeCounts(store, done, 1_000);
  assert.deepEqual(await runOutcomeCounts(store, done, 2_000), first, "the second load is the kept answer");
  await runOutcomeCounts(store, running, 1_000);
  await runOutcomeCounts(store, running, 2_000);
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

test("a kept count expires, so a change made from another process is seen within the TTL (#644)", async () => {
  const store = countingStore();
  const done = { id: "r-done", status: "COMPLETED" };
  await runOutcomeCounts(store, done, 0);
  await runOutcomeCounts(store, done, COUNTS_TTL_MS - 1);
  assert.equal(store.reads.length, 1);
  await runOutcomeCounts(store, done, COUNTS_TTL_MS);
  assert.equal(store.reads.length, 2, "read again once the TTL has passed");
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
