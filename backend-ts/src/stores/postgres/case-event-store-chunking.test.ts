/**
 * The chunked outreach reads hold ONE connection at a time — the property the batching exists for.
 *
 * The case CSV export did not merely run slowly at 20,000 patients: it fired ~15,300 queries through
 * `Promise.all` against a ten-connection pool, so while it ran every other database-backed endpoint
 * queued behind it (`/api/panels` 0.3 s idle → three consecutive 45 s timeouts, measured 2026-09-13).
 * Batching the query fixed the count. Nothing, until this file, fixed the SHAPE: replacing the `for`
 * loop with `await Promise.all(chunks.map(...))` returns exactly the same map, so every contract test
 * and the export's own call-count test pass unchanged while the pool is held exactly as before. A
 * control that reads as present and cannot fire is this repository's most common real defect, and it
 * would have been sitting inside the fix for one.
 *
 * The pool is injected, so no database is needed: a fake counts how many statements are in flight.
 *
 *   node --import tsx --test src/stores/postgres/case-event-store-chunking.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PgPool } from "./pg-database.ts";
import { OUTREACH_STATUS_CHUNK, PgCaseEventStore } from "./case-event-store-postgres.ts";

/** A pool that records concurrency: every query yields, so anything fired together overlaps. */
function spyPool() {
  const state = { inFlight: 0, peak: 0, statements: 0, idsSeen: [] as string[] };
  const pool = {
    query: async (_sql: string, params?: unknown[]) => {
      state.statements++;
      state.peak = Math.max(state.peak, ++state.inFlight);
      const ids = (params?.[0] as string[] | undefined) ?? [];
      state.idsSeen.push(...ids);
      await new Promise((r) => setImmediate(r));
      state.inFlight--;
      return { rows: [] };
    },
  };
  return { state, pool: pool as unknown as PgPool };
}

/** Enough ids for THREE chunks: two would let a "reads only the first and last chunk" bug survive. */
const ids = () => Array.from({ length: OUTREACH_STATUS_CHUNK * 2 + 1 }, () => crypto.randomUUID());

test("latestOutreachDeliveryStatuses reads one chunk at a time, and reads every chunk", async () => {
  const { state, pool } = spyPool();
  const input = ids();
  await new PgCaseEventStore(pool).latestOutreachDeliveryStatuses(input);

  assert.equal(state.peak, 1, "one statement in flight at a time — the export must not hold the pool");
  assert.equal(state.statements, 3, "three chunks, all of them read");
  assert.deepEqual(state.idsSeen, input, "every id asked about exactly once, in order, none dropped");
});

test("outreachSentCounts reads one chunk at a time, and reads every chunk", async () => {
  // Its caller is the work list, which can hand it every open case on the deployment.
  const { state, pool } = spyPool();
  const input = ids();
  await new PgCaseEventStore(pool).outreachSentCounts(input);

  assert.equal(state.peak, 1, "one statement in flight at a time");
  assert.equal(state.statements, 3, "three chunks, all of them read");
  assert.deepEqual(state.idsSeen, input, "every id asked about exactly once, in order, none dropped");
});

test("a non-uuid id is dropped before the query, and an all-non-uuid set asks nothing", async () => {
  const { state, pool } = spyPool();
  const store = new PgCaseEventStore(pool);
  const good = crypto.randomUUID();
  assert.deepEqual(await store.latestOutreachDeliveryStatuses(["not-a-uuid", "", good]), {});
  assert.deepEqual(state.idsSeen, [good], "only the uuid reached the ::uuid[] bind");

  const before = state.statements;
  assert.deepEqual(await store.latestOutreachDeliveryStatuses(["nope", "also-nope"]), {});
  assert.equal(state.statements, before, "nothing left to ask, so no statement is issued");
});
