/**
 * aggregateScaleRun (#185 E13 PR-2) — the floor implementation groups a scale run's outcomes by
 * (location, provider, status) parsed from the encoded subject_id, returning O(providers) rows.
 *   node --import tsx --test src/stores/sqlite/outcome-store-scale.test.ts
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
import { SqliteOutcomeStore } from "./outcome-store-sqlite.ts";
import { encodeScaleSubject } from "../../engine/synthetic/scale-structure.ts";

const dbPath = join(tmpdir(), `workwell-scale-${crypto.randomUUID()}.sqlite`);
let runs: SqliteRunStore;
let outcomes: SqliteOutcomeStore;
let runId: string;

async function scaleRun(): Promise<string> {
  const run = await runs.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed:scale", status: "COMPLETED",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  return run.id;
}

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  runs = new SqliteRunStore(db);
  outcomes = new SqliteOutcomeStore(db);
  runId = await scaleRun();
  // L00/P00: 2 COMPLIANT, 1 OVERDUE; L00/P01: 1 COMPLIANT
  await outcomes.recordOutcomes([
    { runId, subjectId: encodeScaleSubject(0, 0, 1), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId, subjectId: encodeScaleSubject(0, 0, 2), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId, subjectId: encodeScaleSubject(0, 0, 3), measureId: "audiogram", status: "OVERDUE", evidence: {} },
    { runId, subjectId: encodeScaleSubject(0, 1, 4), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
  ]);
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("aggregateScaleRun groups by location/provider/status (bounded rows)", async () => {
  const groups = await outcomes.aggregateScaleRun(runId);
  const key = (g: { locationId: string; providerId: string; status: string }) => `${g.locationId}/${g.providerId}/${g.status}`;
  const byKey = new Map(groups.map((g) => [key(g), g.count]));
  assert.equal(byKey.get("L00/P00/COMPLIANT"), 2);
  assert.equal(byKey.get("L00/P00/OVERDUE"), 1);
  assert.equal(byKey.get("L00/P01/COMPLIANT"), 1);
  assert.equal(groups.length, 3, "3 provider×status groups, not 4 subject rows");
  assert.equal(groups.reduce((s, g) => s + g.count, 0), 4);
});

test("excludeScale drops seed:scale rows IN SQL (bounded-memory guard for the live read path)", async () => {
  // a live MANUAL run for the same measure + the existing seed:scale run from `before`
  const live = await runs.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "manual", status: "COMPLETED",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: live.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });

  const withScale = await outcomes.listOutcomesWithRun({ measureId: "audiogram" });
  const withoutScale = await outcomes.listOutcomesWithRun({ measureId: "audiogram", excludeScale: true });
  assert.ok(withScale.some((r) => r.subjectId.startsWith("mhn|")), "default scan still returns scale rows");
  assert.ok(!withoutScale.some((r) => r.subjectId.startsWith("mhn|")), "excludeScale removes ALL scale rows in SQL");
  assert.ok(withoutScale.some((r) => r.subjectId === "emp-006"), "live rows are kept");

  // listOutcomesForMeasure excludeScale too
  const measOnly = await outcomes.listOutcomesForMeasure("audiogram", { excludeScale: true });
  assert.ok(!measOnly.some((r) => r.subjectId.startsWith("mhn|")), "listOutcomesForMeasure excludeScale drops scale");
});

test("excludeTrendHistory + combined scale/trend filter keep only live rows (Fix A refactor guard)", async () => {
  // Pin the exact result set of the run-scoped exclusion so the perf rewrite (run_id = ANY(<live runs>)
  // instead of a joined `triggered_by <> …`) can't silently change which rows survive.
  const period = { measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z" };
  const trend = await runs.createRun({ scopeType: "MEASURE", scopeId: "hazwoper", triggeredBy: "seed:trend-history", status: "COMPLETED", requestedScope: { measureId: "hazwoper" }, ...period });
  await outcomes.recordOutcome({ runId: trend.id, subjectId: "emp-010", measureId: "hazwoper", status: "COMPLIANT", evidence: {} });
  const liveRun = await runs.createRun({ scopeType: "MEASURE", scopeId: "hazwoper", triggeredBy: "manual", status: "COMPLETED", requestedScope: { measureId: "hazwoper" }, ...period });
  await outcomes.recordOutcome({ runId: liveRun.id, subjectId: "emp-011", measureId: "hazwoper", status: "OVERDUE", evidence: {} });
  const scale = await runs.createRun({ scopeType: "MEASURE", scopeId: "hazwoper", triggeredBy: "seed:scale", status: "COMPLETED", requestedScope: { measureId: "hazwoper" }, ...period });
  await outcomes.recordOutcome({ runId: scale.id, subjectId: encodeScaleSubject(0, 0, 1), measureId: "hazwoper", status: "COMPLIANT", evidence: {} });

  const noTrend = await outcomes.listOutcomesWithRun({ measureId: "hazwoper", excludeTrendHistory: true });
  assert.ok(!noTrend.some((r) => r.subjectId === "emp-010"), "excludeTrendHistory drops trend rows");
  assert.ok(noTrend.some((r) => r.subjectId === "emp-011"), "excludeTrendHistory keeps live rows");

  const both = await outcomes.listOutcomesWithRun({ measureId: "hazwoper", excludeScale: true, excludeTrendHistory: true });
  assert.ok(!both.some((r) => r.subjectId.startsWith("mhn|")), "combined filter drops scale");
  assert.ok(!both.some((r) => r.subjectId === "emp-010"), "combined filter drops trend");
  assert.deepEqual(both.map((r) => r.subjectId).sort(), ["emp-011"], "combined filter keeps only the live row");
});

test("exclusion filter composes with measureId + from/to window (bind-order guard)", async () => {
  // The from/to window + a measure filter + both exclusions is the case that most stresses the
  // parameter builder (Pg $N numbering / SQLite positional ?): the exclusion clause is appended last
  // with its binds after measureId/from/to. Assert the surviving set with all four composed.
  const mk = (triggeredBy: string, startedAt: string, subjectId: string, measureId = "tb_surveillance") =>
    runs
      .createRun({
        scopeType: "MEASURE", scopeId: measureId, triggeredBy, status: "COMPLETED", startedAt,
        requestedScope: { measureId },
        measurementPeriodStart: startedAt, measurementPeriodEnd: startedAt,
      })
      .then((r) => outcomes.recordOutcome({ runId: r.id, subjectId, measureId, status: "OVERDUE", evidence: {} }));

  await mk("manual", "2026-05-15T00:00:00.000Z", "emp-020"); // in window, live → kept
  await mk("manual", "2026-04-01T00:00:00.000Z", "emp-021"); // before window → dropped by `from`
  await mk("seed:trend-history", "2026-05-16T00:00:00.000Z", "emp-022"); // in window but excluded
  await mk("seed:scale", "2026-05-16T00:00:00.000Z", encodeScaleSubject(0, 0, 9)); // in window but excluded
  await mk("manual", "2026-05-15T00:00:00.000Z", "emp-023", "flu_vaccine"); // in window but wrong measure

  const got = await outcomes.listOutcomesWithRun({
    measureId: "tb_surveillance", from: "2026-05-01", to: "2026-05-31",
    excludeScale: true, excludeTrendHistory: true,
  });
  assert.deepEqual(got.map((r) => r.subjectId).sort(), ["emp-020"], "only the in-window live tb_surveillance row survives");
});

test("aggregateScaleRun memoizes per runId (COMPLETED seed:scale runs are immutable)", async () => {
  // A COMPLETED seed:scale run is written once and never re-evaluated, so its aggregation is a pure
  // function of an immutable runId — memoized in-process to keep the hierarchy/overview reads off a
  // repeated 120k-row GROUP BY. The cache must serve the first result even if the rows later change.
  const rid = await scaleRun();
  await outcomes.recordOutcome({ runId: rid, subjectId: encodeScaleSubject(0, 0, 1), measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  const first = await outcomes.aggregateScaleRun(rid);
  assert.equal(first.reduce((s, g) => s + g.count, 0), 1);
  await outcomes.recordOutcome({ runId: rid, subjectId: encodeScaleSubject(0, 0, 2), measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  const second = await outcomes.aggregateScaleRun(rid);
  assert.equal(second.reduce((s, g) => s + g.count, 0), 1, "cached result is unchanged (run treated as immutable)");
});

test("group count is bounded by structure, not by subject count", async () => {
  const small = await scaleRun();
  const big = await scaleRun();
  const spread = (rid: string, n: number) =>
    outcomes.recordOutcomes(
      Array.from({ length: n }, (_, i) => ({
        runId: rid,
        subjectId: encodeScaleSubject(i % 24, Math.floor(i / 24) % 10, i),
        measureId: "audiogram",
        status: i % 2 === 0 ? "COMPLIANT" : "OVERDUE",
        evidence: {},
      })),
    );
  await spread(small, 2000);
  await spread(big, 20000);
  const a = await outcomes.aggregateScaleRun(small);
  const b = await outcomes.aggregateScaleRun(big);
  assert.equal(a.length, b.length, "group count independent of N");
  assert.equal(b.reduce((s, g) => s + g.count, 0), 20000);
});
