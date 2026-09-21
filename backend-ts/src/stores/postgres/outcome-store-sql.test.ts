/**
 * The SQL the CEILING actually emits, checked without a server.
 *
 * The store-contract tests are the real guarantee, and they self-skip wherever no local `postgres:16`
 * is serviced — which is every developer host that has not started one. Both #544 defects passed the
 * SQLite floor for exactly that reason. A statement assembled from concatenated fragments can lose a
 * space or strand a clause, and neither the floor nor a typecheck sees it; a fake pool that records
 * the text does.
 *
 *   node --import tsx --test src/stores/postgres/outcome-store-sql.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PgPool } from "./pg-database.ts";
import { PgOutcomeStore } from "./outcome-store-postgres.ts";

const RUN = "11111111-2222-3333-4444-555555555555";

/**
 * A pool that keeps every statement's text and answers from `rowsFor` — which must be able to answer
 * the winners walk with real-looking rows, or a memo test cannot tell a cached probe from a probe
 * that never happened.
 */
function recordingPool(rowsFor: (sql: string) => unknown[] = () => []): { pool: PgPool; sql: string[]; binds: unknown[][] } {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      sql.push(text);
      binds.push(values ?? []);
      const rows = rowsFor(text);
      return { rows, rowCount: rows.length };
    },
  } as unknown as PgPool;
  return { pool, sql, binds };
}

/** The candidate read answers with one terminal ALL_PROGRAMS run; the probe says it holds the measure. */
const walkAnswers = (text: string): unknown[] => {
  if (text.includes("FROM unnest(")) return [{ measure_id: "cms122" }];
  if (text.includes(".runs r WHERE")) {
    return [{ id: RUN, started_at: "2026-09-20T12:00:00.000Z", scope_type: "ALL_PROGRAMS", status: "COMPLETED", triggered_by: "scheduler" }];
  }
  return [];
};

/** Collapse whitespace so the assertions read as one line, as the planner sees it. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

test("listOutcomes: the default read is ordered; order:'none' drops exactly the ORDER BY", async () => {
  const { pool, sql, binds } = recordingPool();
  const store = new PgOutcomeStore(pool);

  await store.listOutcomes(RUN, { measureId: "cms122" });
  assert.match(flat(sql[0]!), /WHERE run_id = \$1 AND measure_id = \$2 ORDER BY evaluated_at ASC, id ASC$/);

  await store.listOutcomes(RUN, { measureId: "cms122", order: "none" });
  const unordered = flat(sql[1]!);
  assert.match(unordered, /WHERE run_id = \$1 AND measure_id = \$2$/, "no trailing clause, no dangling keyword");
  assert.ok(!unordered.includes("ORDER BY"), "the sort is gone");
  assert.deepEqual(binds[1], [RUN, "cms122"], "and the binds still line up with the placeholders");
});

test("listOutcomes: a PAGED read keeps its ordering even when order:'none' is asked for", async () => {
  // Paging an unordered relation may repeat or skip rows between pages, so the option must lose to
  // the page window rather than the other way round.
  const { pool, sql } = recordingPool();
  const store = new PgOutcomeStore(pool);
  await store.listOutcomes(RUN, { measureId: "cms122", limit: 2000, offset: 4000, order: "none" });
  assert.match(flat(sql[0]!), /ORDER BY evaluated_at ASC, id ASC LIMIT \$3 OFFSET \$4$/);
});

test("listOutcomes: every filter composes with the unordered read", async () => {
  const { pool, sql, binds } = recordingPool();
  const store = new PgOutcomeStore(pool);
  await store.listOutcomes(RUN, { measureId: "cms122", subjectId: "p-1", subjectIds: ["p-1", "p-2"], order: "none" });
  assert.match(
    flat(sql[0]!),
    /WHERE run_id = \$1 AND measure_id = \$2 AND subject_id = \$3 AND subject_id = ANY\(\$4::text\[\]\)$/,
  );
  assert.deepEqual(binds[0], [RUN, "cms122", "p-1", ["p-1", "p-2"]]);
});

test("listLatestPopulationRuns: the candidate read runs every call, the PROBES only on a miss", async () => {
  // The whole point of the memo (`stores/probe-cache.ts`): the cheap indexed statement over `runs` is
  // paid every time — it is what validates the memo — and the `EXISTS` probes, the expensive half and
  // the 2.5–4 s the dashboard paid thirteen times over, are paid once per candidate list.
  const { pool, sql } = recordingPool(walkAnswers);
  const store = new PgOutcomeStore(pool);
  const filter = { excludeScale: true, excludeTrendHistory: true };
  const probes = () => sql.filter((t) => t.includes("FROM unnest(")).length;
  const candidates = () => sql.filter((t) => t.includes(".runs r WHERE")).length;

  const first = await store.listLatestPopulationRuns(["cms122"], filter);
  assert.deepEqual(first.map((w) => [w.measureId, w.runId]), [["cms122", RUN]], "the walk resolved a winner");
  assert.match(flat(sql[0]!), /^SELECT r\.id, r\.started_at, r\.scope_type, r\.status, r\.triggered_by FROM \S+\.runs r WHERE /);
  assert.match(flat(sql[0]!), /ORDER BY r\.started_at DESC, r\.id DESC LIMIT \d+$/);
  assert.equal(candidates(), 1);
  assert.equal(probes(), 1);

  const second = await store.listLatestPopulationRuns(["cms122"], filter);
  assert.deepEqual(second, first, "same answer");
  assert.equal(candidates(), 2, "the candidate list is re-read, because it is the key");
  assert.equal(probes(), 1, "and the probe is not re-issued");

  // A different measure set is a different question and must not be served the first answer.
  await store.listLatestPopulationRuns(["cms122", "cms125"], filter);
  assert.equal(probes(), 2);
  // Nor may a different date window, which changes what step 2 would consider even at a fixed list.
  await store.listLatestPopulationRuns(["cms122"], { ...filter, from: "2026-01-01" });
  assert.equal(probes(), 3);
  // Nor a different window size — `perMeasure` is the trend's, and it asks for ten runs, not one.
  await store.listLatestPopulationRuns(["cms122"], filter, 10);
  assert.equal(probes(), 4);
});

test("listLatestPopulationRuns: an empty measure list never touches the database", async () => {
  const { pool, sql } = recordingPool(walkAnswers);
  const store = new PgOutcomeStore(pool);
  assert.deepEqual(await store.listLatestPopulationRuns([], { excludeScale: true }), []);
  assert.equal(sql.length, 0, "nothing to ask about, so nothing is asked");
});
