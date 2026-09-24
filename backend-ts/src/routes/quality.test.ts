/**
 * Quality history route (#E16 PR-2): seed a couple of quality_snapshots, then assert
 * GET /api/quality/history returns the time-series, honors the measure/scope/range filters,
 * and 400s on a malformed YYYY-MM bound.
 *   node --import tsx --test src/routes/quality.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteQualitySnapshotStore } from "../stores/sqlite/quality-snapshot-store-sqlite.ts";
import type { QualitySnapshotInput } from "../stores/quality-snapshot-store.ts";
import { handleQuality } from "./quality.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";

const dbPath = join(tmpdir(), `workwell-quality-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (qs = "") => handleQuality(new Request(`http://x/api/quality/history${qs}`, { method: "GET" }), env as never);

const snap = (over: Partial<QualitySnapshotInput>): QualitySnapshotInput => ({
  measureId: "audiogram", period: "2026-05", periodStart: "2026-05-01T00:00:00.000Z", periodEnd: "2026-05-31T23:59:59.999Z",
  scopeLevel: "all", scopeId: "ALL", tenantId: null,
  numerator: 8, denominator: 10, compliant: 8, dueSoon: 1, overdue: 1, missingData: 0, excluded: 0,
  sourceRunId: null, computedAt: "2026-05-31T00:00:00.000Z", ...over,
});

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const store = new SqliteQualitySnapshotStore(db);
  await store.upsertSnapshots([
    snap({ period: "2026-04", numerator: 6 }),
    snap({ period: "2026-05", numerator: 8 }),
    snap({ period: "2026-05", scopeLevel: "tenant", scopeId: "twh", tenantId: "twh", numerator: 4 }),
    snap({ measureId: "hazwoper", period: "2026-05", numerator: 9 }),
  ]);
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

interface Row { measureId: string; period: string; scopeLevel: string; scopeId: string; numerator: number; }

test("GET /api/quality/history returns the measure time-series, period ASC", async () => {
  const res = await get("?measureId=audiogram&scopeLevel=all");
  assert.equal(res?.status, 200);
  const rows = (await res!.json()) as Row[];
  assert.deepEqual(rows.map((r) => r.period), ["2026-04", "2026-05"]);
  assert.equal(rows[0]!.numerator, 6);
});

test("scope + tenant filter narrows to the tenant row", async () => {
  const res = await get("?measureId=audiogram&scopeLevel=tenant&scopeId=twh");
  const rows = (await res!.json()) as Row[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.numerator, 4);
});

test("from/to bound the range (inclusive)", async () => {
  const res = await get("?measureId=audiogram&scopeLevel=all&from=2026-05&to=2026-05");
  const rows = (await res!.json()) as Row[];
  assert.deepEqual(rows.map((r) => r.period), ["2026-05"]);
});

test("missing measureId → 400 (bounded read)", async () => {
  assert.equal((await get(""))?.status, 400);
  assert.equal((await get("?scopeLevel=all"))?.status, 400);
});

test("malformed from → 400", async () => {
  assert.equal((await get("?measureId=audiogram&from=2026-5"))?.status, 400);
  assert.equal((await get("?measureId=audiogram&to=2026-13"))?.status, 400);
  assert.equal((await get("?measureId=audiogram&from=not-a-month"))?.status, 400);
  assert.equal((await get("?measureId=audiogram&from=2026-01&to=2026-12"))?.status, 200);
});

test("bad scopeLevel → 400", async () => {
  assert.equal((await get("?measureId=audiogram&scopeLevel=galaxy"))?.status, 400);
});

test("non-GET and unrelated path → null", async () => {
  assert.equal(await handleQuality(new Request("http://x/api/quality/history", { method: "POST" }), env as never), null);
  assert.equal(await handleQuality(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

// ── #642: the history is refused for a measure whose snapshots understate its rate ──────────────────

test("#642: an officially routed measure's monthly history is refused (409), never served as its rate", async () => {
  const store = new SqliteQualitySnapshotStore(env.DB as never);
  // What the pilot served: 3,388 / 19,636 = 17.3% for a measure whose population rate is 41.9%.
  await store.upsertSnapshots([snap({ measureId: "cms130", numerator: 3388, denominator: 19636, compliant: 3388, missingData: 11543 })]);
  const prev = process.env.WORKWELL_OFFICIAL_MEASURES;
  process.env.WORKWELL_OFFICIAL_MEASURES = "cms130";
  try {
    const res = await get("?measureId=cms130&scopeLevel=all");
    assert.equal(res?.status, 409);
    const body = (await res!.json()) as { error: string; message: string };
    assert.equal(body.error, "snapshot_basis_unsafe");
    assert.match(body.message, /(employees|patients) the measure does not apply to/);
  } finally {
    if (prev === undefined) delete process.env.WORKWELL_OFFICIAL_MEASURES;
    else process.env.WORKWELL_OFFICIAL_MEASURES = prev;
  }
});

test("#642: the ROWS decide too — an authored measure whose latest run has out-of-population subjects is refused", async () => {
  // A routing rollback after official runs were written: today's env says authored, the data says not.
  const runs = new SqliteRunStore(env.DB as never);
  const outcomes = new SqliteOutcomeStore(env.DB as never);
  const run = await runs.createRun({ scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {}, measurementPeriodStart: "2026-06-30T00:00:00.000Z", measurementPeriodEnd: "2026-06-30T00:00:00.000Z" });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "hazwoper", status: "COMPLIANT", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-002", measureId: "hazwoper", status: "MISSING_DATA", evidence: {}, outOfPopulation: true });
  await runs.finalizeRun(run.id, "COMPLETED");
  assert.equal((await get("?measureId=hazwoper&scopeLevel=all"))?.status, 409);
});

test("#642: a measure with no out-of-population subjects still gets its history", async () => {
  const runs = new SqliteRunStore(env.DB as never);
  const outcomes = new SqliteOutcomeStore(env.DB as never);
  const run = await runs.createRun({ scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {}, measurementPeriodStart: "2026-06-30T00:00:00.000Z", measurementPeriodEnd: "2026-06-30T00:00:00.000Z" });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-002", measureId: "audiogram", status: "MISSING_DATA", evidence: {}, outOfPopulation: false });
  await runs.finalizeRun(run.id, "COMPLETED");
  const res = await get("?measureId=audiogram&scopeLevel=all");
  assert.equal(res?.status, 200);
  assert.equal(((await res!.json()) as Row[]).length, 2);
});
