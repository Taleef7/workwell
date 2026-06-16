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
import { SqliteOutcomeStore } from "./sqlite/outcome-store-sqlite.ts";

const dbPath = join(tmpdir(), `workwell-case-period-${crypto.randomUUID()}.sqlite`);
let store: SqliteCaseStore;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  store = new SqliteCaseStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  // A case + the outcome that produced it (the worklist's current cycle is MAX over OUTCOMES at
  // cycle anchors). seedCase mirrors a real run writing both.
  const seedCase = async (subjectId: string, measureId: string, period: string, status: string) => {
    const c = await store.upsertFromOutcome({ runId: run.id, subjectId, measureId, evaluationPeriod: period, outcomeStatus: status });
    await outcomes.recordOutcome({ runId: run.id, subjectId, measureId, evaluationPeriod: period, status, evidence: {} });
    return c;
  };

  // Two compliance cycles of the SAME measure for the SAME employee → two distinct rows
  // (the idempotency key includes evaluation_period): a prior cycle and the current one.
  await seedCase("emp-006", "audiogram", "2025-01-01", "OVERDUE");
  await seedCase("emp-006", "audiogram", "2026-01-01", "OVERDUE");

  // Codex P1 fixture on a SEPARATE measure: an OPEN case at the cycle anchor plus two TERMINAL stale
  // cases whose RAW daily periods are lexically LATER — a CLOSED row (a V022-cleaned row) and an
  // EXCLUDED row with closed_at = NULL (the Java upsertExcludedCase convention, which V022 does NOT
  // close). Their outcomes sit at non-anchor periods, so the anchor-restricted MAX-over-outcomes
  // ignores them and `current` surfaces the open anchor.
  await seedCase("emp-006", "hazwoper", "2026-01-01", "OVERDUE");
  const closedStale = await seedCase("emp-006", "hazwoper", "2026-06-15", "OVERDUE");
  await store.patchCase(closedStale!.id, { status: "CLOSED", closedAt: new Date().toISOString(), closedReason: "STALE_PERIOD_CLEANUP" });
  const excludedStale = await seedCase("emp-006", "hazwoper", "2026-09-09", "EXCLUDED");
  await store.patchCase(excludedStale!.id, { status: "EXCLUDED", closedAt: null });

  // Codex P2 fixture (latest EVALUATED cycle) on tb_surveillance: a lingering OPEN case in a PRIOR
  // cycle (2026-01-01), and a LATER cycle (2027-01-01) that was evaluated but produced no open case
  // (all compliant → an outcome only). `current` must follow the latest evaluated cycle (2027) and
  // show nothing, not fall back to the prior cycle's stale open.
  await seedCase("emp-006", "tb_surveillance", "2026-01-01", "OVERDUE");
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-007", measureId: "tb_surveillance", evaluationPeriod: "2027-01-01", status: "COMPLIANT", evidence: {} });
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

test("period 'current' ignores terminal (CLOSED + EXCLUDED) stale rows with later periods (Codex P1)", async () => {
  // hazwoper: OPEN anchor at 2026-01-01, CLOSED stale at 2026-06-15, EXCLUDED stale (closed_at NULL)
  // at 2026-09-09. The MAX-over-outcomes is restricted to cycle anchors, so the later raw-date rows'
  // outcomes are ignored and 'current' returns the open anchor (the EXCLUDED-with-null-closed_at row
  // is the Codex P1 case that a closed_at-based predicate would have missed).
  const rows = await store.listCases({ measureId: "hazwoper", period: "current" });
  assert.deepEqual(
    rows.map((c) => c.evaluationPeriod),
    ["2026-01-01"],
    "the later CLOSED (2026-06-15) and EXCLUDED (2026-09-09) rows must not poison MAX and hide the open anchor",
  );
});

test("period 'current' follows the latest EVALUATED cycle, not the latest open row (Codex P2)", async () => {
  // tb_surveillance was evaluated in 2027-01-01 (an outcome, but no open case → all compliant) after a
  // prior cycle (2026-01-01) left an open case. 'current' follows the latest evaluated cycle (2027) and
  // shows nothing — it does NOT fall back to the prior cycle's stale open.
  const rows = await store.listCases({ measureId: "tb_surveillance", period: "current" });
  assert.deepEqual(
    rows.map((c) => c.evaluationPeriod),
    [],
    "current cycle (2027, evaluated) has no open cases; the prior-cycle open (2026) is not surfaced",
  );
});
