/**
 * Case worklist period-filter test (#150 H1) — TS parity with the Java
 * `CaseWorklistPeriodIntegrationTest`. Seeds two compliance cycles of one measure
 * and asserts the `period` filter: omitted → all, `current` → newest cycle only,
 * `all` → all, concrete anchor → exactly that cycle.
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
  // Two compliance cycles of the SAME measure for the SAME employee → two distinct rows
  // (the idempotency key includes evaluation_period): a prior cycle and the current one.
  await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2025-01-01", outcomeStatus: "OVERDUE" });
  await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-01-01", outcomeStatus: "OVERDUE" });

  // Finding 1 (Codex P1) fixture on a SEPARATE measure: an OPEN case at the cycle anchor plus a
  // CLOSED stale case whose RAW daily period ("2026-06-15") is lexically LATER than the anchor —
  // mimicking a V022-cleaned row. `current` must still surface the open anchor, not be poisoned
  // by the later closed period.
  await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "hazwoper", evaluationPeriod: "2026-01-01", outcomeStatus: "OVERDUE" });
  const stale = await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "hazwoper", evaluationPeriod: "2026-06-15", outcomeStatus: "OVERDUE" });
  await store.patchCase(stale!.id, { status: "CLOSED", closedAt: new Date().toISOString(), closedReason: "STALE_PERIOD_CLEANUP" });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("period omitted → no filter (every cycle; the primitive default for exports/MCP/analytics)", async () => {
  const rows = await store.listCases({ measureId: "audiogram" });
  assert.deepEqual(rows.map((c) => c.evaluationPeriod).sort(), ["2025-01-01", "2026-01-01"]);
});

test("period 'current' → only the measure's most-recent compliance cycle (worklist default)", async () => {
  const rows = await store.listCases({ measureId: "audiogram", period: "current" });
  assert.deepEqual(rows.map((c) => c.evaluationPeriod), ["2026-01-01"]);
});

test("period 'all' → every cycle (explicit, case-insensitive)", async () => {
  assert.equal((await store.listCases({ measureId: "audiogram", period: "all" })).length, 2);
  assert.equal((await store.listCases({ measureId: "audiogram", period: "ALL" })).length, 2);
});

test("period '2025-01-01' → exactly that cycle", async () => {
  const rows = await store.listCases({ measureId: "audiogram", period: "2025-01-01" });
  assert.deepEqual(rows.map((c) => c.evaluationPeriod), ["2025-01-01"]);
});

test("period 'current' ignores a CLOSED stale row even when its raw period is later (Codex P1)", async () => {
  // hazwoper has an OPEN anchor case at 2026-01-01 and a CLOSED stale case at 2026-06-15. The MAX
  // is over OPEN cases only, so 'current' returns the open anchor — the later closed period must
  // not hide it.
  const rows = await store.listCases({ measureId: "hazwoper", period: "current" });
  assert.deepEqual(
    rows.map((c) => c.evaluationPeriod),
    ["2026-01-01"],
    "the later CLOSED 2026-06-15 row must not poison MAX and hide the open anchor",
  );
});
