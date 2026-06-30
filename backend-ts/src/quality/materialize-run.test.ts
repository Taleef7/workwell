/**
 * E16 — materializeRun integration. A completed population run's live outcomes (+ the latest scale run,
 * folded via the bounded aggregateScaleRun) become persisted, reconciling quality_snapshots, and the
 * materialization is audited. Floor stores + the real synthetic directory.
 *   node --import tsx --test src/quality/materialize-run.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteQualitySnapshotStore } from "../stores/sqlite/quality-snapshot-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { materializeRun, QUALITY_SNAPSHOT_MATERIALIZED_EVENT, type MaterializeDeps } from "./materialize-run.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { encodeScaleSubject } from "../engine/synthetic/scale-structure.ts";
import { SCALE_TRIGGER } from "../run/backfill-scale.ts";

const created: string[] = [];
async function freshStores(): Promise<MaterializeDeps & { events: SqliteCaseEventStore }> {
  const dbPath = join(tmpdir(), `workwell-matq-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return {
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    qualitySnapshots: new SqliteQualitySnapshotStore(db),
    events: new SqliteCaseEventStore(db),
  };
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

const twh = EMPLOYEES.filter((e) => e.tenantId === "twh").slice(0, 3);
const ihn = EMPLOYEES.filter((e) => e.tenantId === "ihn").slice(0, 2);

type Stores = MaterializeDeps & { events: SqliteCaseEventStore };

async function popRun(s: Stores, over: Record<string, unknown> = {}) {
  return s.runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "manual",
    requestedScope: {},
    measurementPeriodStart: "2025-06-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-01T00:00:00.000Z",
    startedAt: "2026-06-15T10:00:00.000Z",
    completedAt: "2026-06-15T10:05:00.000Z",
    status: "COMPLETED",
    ...over,
  } as Parameters<SqliteRunStore["createRun"]>[0]);
}

async function seedLive(s: Stores, runId: string): Promise<void> {
  await s.outcomeStore.recordOutcomes([
    { runId, subjectId: twh[0]!.externalId, measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId, subjectId: twh[1]!.externalId, measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId, subjectId: twh[2]!.externalId, measureId: "audiogram", status: "OVERDUE", evidence: {} },
    { runId, subjectId: ihn[0]!.externalId, measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId, subjectId: ihn[1]!.externalId, measureId: "audiogram", status: "EXCLUDED", evidence: {} },
  ]);
}

async function seedScale(s: Stores): Promise<void> {
  const scaleRun = await s.runStore.createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: SCALE_TRIGGER,
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2025-06-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-01T00:00:00.000Z",
    startedAt: "2026-06-10T00:00:00.000Z",
    completedAt: "2026-06-10T00:00:00.000Z",
    status: "COMPLETED",
  });
  await s.outcomeStore.recordOutcomes([
    { runId: scaleRun.id, subjectId: encodeScaleSubject(0, 0, 1), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId: scaleRun.id, subjectId: encodeScaleSubject(0, 0, 2), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId: scaleRun.id, subjectId: encodeScaleSubject(0, 1, 3), measureId: "audiogram", status: "OVERDUE", evidence: {} },
    { runId: scaleRun.id, subjectId: encodeScaleSubject(1, 2, 4), measureId: "audiogram", status: "MISSING_DATA", evidence: {} },
  ]);
}

test("materializeRun: persists reconciling snapshots (live + folded scale) and writes an audit event", async () => {
  const s = await freshStores();
  const run = await popRun(s);
  await seedLive(s, run.id);
  await seedScale(s);

  const res = await materializeRun(run.id, s);
  assert.equal(res.materialized, true);
  assert.equal(res.period, "2026-06");
  assert.ok(res.rows > 0);

  const rows = await s.qualitySnapshots.querySnapshots({ measureId: "audiogram" });
  const all = rows.find((r) => r.scopeLevel === "all" && r.scopeId === "ALL")!;
  assert.ok(all);
  assert.equal(all.compliant, 5); // live 3 + scale 2
  assert.equal(all.overdue, 2); // live 1 + scale 1
  assert.equal(all.excluded, 1);
  assert.equal(all.missingData, 1);
  assert.equal(all.numerator, 5);
  assert.equal(all.denominator, 8); // total 9 − excluded 1
  assert.equal(all.sourceRunId, run.id);

  const tenants = rows.filter((r) => r.scopeLevel === "tenant");
  assert.deepEqual(tenants.map((t) => t.tenantId).sort(), ["ihn", "mhn", "twh"]);
  for (const k of ["numerator", "denominator", "compliant", "overdue", "excluded", "missingData", "dueSoon"] as const) {
    assert.equal(tenants.reduce((a, t) => a + t[k], 0), all[k], `Σ tenants.${k} = all.${k}`);
  }

  const evs = await s.events.recentAuditEventsByType(QUALITY_SNAPSHOT_MATERIALIZED_EVENT, 10);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.refRunId, run.id);
  assert.equal(evs[0]!.payload.period, "2026-06");
});

test("materializeRun: idempotent — re-running the same run overwrites, never duplicates", async () => {
  const s = await freshStores();
  const run = await popRun(s);
  await seedLive(s, run.id);
  await materializeRun(run.id, s);
  const first = await s.qualitySnapshots.querySnapshots({ measureId: "audiogram" });
  await materializeRun(run.id, s);
  const second = await s.qualitySnapshots.querySnapshots({ measureId: "audiogram" });
  assert.equal(second.length, first.length, "re-materializing the same run does not add rows");
  assert.ok(first.length > 0);
});

test("materializeRun: skips non-population scopes and seed:scale runs", async () => {
  const s = await freshStores();
  const emp = await popRun(s, { scopeType: "EMPLOYEE", scopeId: twh[0]!.externalId });
  assert.equal((await materializeRun(emp.id, s)).materialized, false);

  const scale = await popRun(s, { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: SCALE_TRIGGER });
  assert.equal((await materializeRun(scale.id, s)).materialized, false);

  assert.deepEqual(await s.qualitySnapshots.querySnapshots({}), []);
});
