/**
 * Case store period-filter test (#150 H1). The store filters only by an EXPLICIT period: a concrete
 * `YYYY-MM-DD` → exact cycle; omitted / `all` / `current` → no filter. The worklist's current-cycle
 * default is computed per-measure from today's cadence in the route (date-driven), not here — so the
 * Codex P1/P2 cases (stale/cadence/rolled-over cycles) are covered by the route test, not this one.
 *   node --import tsx --test src/stores/case-store-period.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./sqlite/schema.ts";
import { SqliteCaseStore } from "./sqlite/case-store-sqlite.ts";
import { SqliteRunStore } from "./sqlite/run-store-sqlite.ts";

const dbPath = join(tmpdir(), `workwell-case-period-${crypto.randomUUID()}.sqlite`);
let store: SqliteCaseStore;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  store = new SqliteCaseStore(db);
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  // Two compliance cycles of the same measure for the same employee (distinct rows — the idempotency
  // key includes evaluation_period).
  await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2025-01-01", outcomeStatus: "OVERDUE" });
  await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-01-01", outcomeStatus: "OVERDUE" });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("period omitted → no filter (every cycle)", async () => {
  const rows = await store.listCases({ measureId: "audiogram" });
  assert.deepEqual(rows.map((c) => c.evaluationPeriod).sort(), ["2025-01-01", "2026-01-01"]);
});

test("period 'all' / 'current' → no store filter (current cycle is computed in the route)", async () => {
  assert.equal((await store.listCases({ measureId: "audiogram", period: "all" })).length, 2);
  assert.equal((await store.listCases({ measureId: "audiogram", period: "ALL" })).length, 2);
  assert.equal((await store.listCases({ measureId: "audiogram", period: "current" })).length, 2);
});

test("period '2025-01-01' → exactly that cycle", async () => {
  const rows = await store.listCases({ measureId: "audiogram", period: "2025-01-01" });
  assert.deepEqual(rows.map((c) => c.evaluationPeriod), ["2025-01-01"]);
});
