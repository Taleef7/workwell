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
