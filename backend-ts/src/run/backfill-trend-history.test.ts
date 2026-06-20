/**
 * Tests for `backfillTrendHistory` (synthetic trend history feature) against the in-memory
 * SQLite FLOOR store + the real CQL engine. Asserts: weeks × measures COMPLETED runs are created
 * with backdated, strictly increasing started_at; ~100 outcomes per run; idempotent on a second
 * call (no duplicate runs); the case store is NEVER touched; and `programTrend` then yields more
 * than one distinct complianceRate (the whole point — a wavy line, not a flat one).
 *   node --import tsx --test src/run/backfill-trend-history.test.ts
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
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { programTrend } from "../program/program-read-models.ts";
import { backfillTrendHistory } from "./backfill-trend-history.ts";

const created: string[] = [];
async function freshDb() {
  const dbPath = join(tmpdir(), `workwell-trend-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return db;
}
after(() => {
  for (const p of created) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

function deps(db: Awaited<ReturnType<typeof freshDb>>) {
  return {
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    engine: new CqlExecutionEngine(),
  };
}

const RUNNABLE = Object.keys(MEASURES);
const WEEKS = 4; // small for test speed; the backfill itself defaults to 12
const ASOF = "2026-06-20";

test("backfillTrendHistory creates weeks × measures COMPLETED runs, all triggered by seed:trend-history", async () => {
  const db = await freshDb();
  const d = deps(db);
  const summary = await backfillTrendHistory(d, { weeks: WEEKS, asOf: ASOF });

  const runs = await d.runStore.listRuns(100000);
  assert.equal(runs.length, WEEKS * RUNNABLE.length, "one run per (measure × week)");
  assert.ok(
    runs.every((r) => r.status === "COMPLETED"),
    "every seeded run is COMPLETED",
  );
  assert.ok(
    runs.every((r) => r.scopeType === "MEASURE"),
    "scope is MEASURE",
  );
  assert.equal(summary.runsCreated, WEEKS * RUNNABLE.length);
  assert.equal(summary.skipped, false);
});

test("backfilled runs are backdated with strictly increasing started_at per measure (oldest→newest)", async () => {
  const db = await freshDb();
  const d = deps(db);
  await backfillTrendHistory(d, { weeks: WEEKS, asOf: ASOF });

  const runs = await d.runStore.listRuns(100000);
  // group by measure (scopeId), assert started_at increases oldest→newest and all are < asOf
  const byMeasure = new Map<string, string[]>();
  for (const r of runs) {
    assert.ok(r.startedAt < `${ASOF}T23:59:59.999Z`, "all runs are backdated before asOf");
    (byMeasure.get(r.scopeId!) ?? byMeasure.set(r.scopeId!, []).get(r.scopeId!)!).push(r.startedAt);
  }
  assert.equal(byMeasure.size, RUNNABLE.length);
  for (const [measureId, dates] of byMeasure) {
    assert.equal(dates.length, WEEKS, `${measureId} has one run per week`);
    const sorted = [...dates].sort();
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i - 1]! < sorted[i]!, `${measureId} started_at strictly increasing`);
    }
  }
});

test("each backfilled run records ~100 outcomes (one per employee)", async () => {
  const db = await freshDb();
  const d = deps(db);
  await backfillTrendHistory(d, { weeks: WEEKS, asOf: ASOF });

  const runs = await d.runStore.listRuns(100000);
  for (const r of runs.slice(0, 5)) {
    const outcomes = await d.outcomeStore.listOutcomes(r.id);
    assert.equal(outcomes.length, EMPLOYEES.length, "one outcome per employee");
    assert.ok(
      outcomes.every((o) => (o.evidence as { seedTrendHistory?: boolean })?.seedTrendHistory === true),
      "outcomes carry the seedTrendHistory marker",
    );
  }
});

test("backfillTrendHistory is idempotent — a second call creates no new runs", async () => {
  const db = await freshDb();
  const d = deps(db);
  await backfillTrendHistory(d, { weeks: WEEKS, asOf: ASOF });
  const before = (await d.runStore.listRuns(100000)).length;

  const second = await backfillTrendHistory(d, { weeks: WEEKS, asOf: ASOF });
  const after = (await d.runStore.listRuns(100000)).length;
  assert.equal(after, before, "no duplicate runs on re-run");
  assert.equal(second.skipped, true, "second call reports skipped");
  assert.equal(second.runsCreated, 0);
});

test("the case store is never touched by the backfill", async () => {
  const db = await freshDb();
  const d = deps(db);
  await backfillTrendHistory(d, { weeks: WEEKS, asOf: ASOF });
  // No caseStore was passed; assert the cases table is empty (nothing leaked in).
  const caseStore = new SqliteCaseStore(db);
  assert.equal((await caseStore.listCases({ limit: 100000 })).length, 0, "no cases created by the backfill");
});

test("programTrend then yields more than one distinct complianceRate (a wavy line, not flat)", async () => {
  const db = await freshDb();
  const d = deps(db);
  await backfillTrendHistory(d, { weeks: WEEKS, asOf: ASOF });

  const caseStore = new SqliteCaseStore(db);
  const trend = await programTrend(
    { runStore: d.runStore, outcomeStore: d.outcomeStore, caseStore },
    "audiogram",
    {},
  );
  assert.ok(trend.length > 1, "multiple trend points");
  const distinct = new Set(trend.map((p) => p.complianceRate));
  assert.ok(distinct.size > 1, `expected a varied trend; got rates ${[...distinct].join(",")}`);
});
