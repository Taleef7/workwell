/**
 * E16 PR-2 — quality-history backfill: assert it materializes real evaluated snapshots per month,
 * is idempotent/resumable at the month level, reconciles All = Σ tenants, and writes an audit event
 * BEFORE the upsert. Uses a fake engine (deterministic) so the test is fast + backend-agnostic.
 *   node --import tsx --test src/run/backfill-quality-history.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqliteQualitySnapshotStore } from "../stores/sqlite/quality-snapshot-store-sqlite.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { backfillQualityHistory, QUALITY_HISTORY_BACKFILLED_EVENT } from "./backfill-quality-history.ts";
import type { SnapshotEngine } from "./employee-compliance-snapshot.ts";

const dbPath = join(tmpdir(), `workwell-quality-backfill-${crypto.randomUUID()}.sqlite`);
let db: Awaited<ReturnType<typeof createSqliteD1>>;
let deps: Parameters<typeof backfillQualityHistory>[0];
let events: SqliteCaseEventStore;

// Deterministic engine: COMPLIANT for even-indexed subjects, OVERDUE for odd — enough to exercise
// bucket counts + reconciliation without running real CQL.
let idx = 0;
const engine: SnapshotEngine = {
  async evaluate() {
    return { outcome: idx++ % 2 === 0 ? "COMPLIANT" : "OVERDUE", evidence: {} };
  },
};

before(async () => {
  db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  events = new SqliteCaseEventStore(db);
  deps = {
    runStore: new SqliteRunStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    qualitySnapshots: new SqliteQualitySnapshotStore(db),
    auditStore: events,
    engine,
    // Keep the workforce small + fast — the first two synthetic employees.
    employees: EMPLOYEES.slice(0, 2),
    today: "2026-06-30",
  };
});
beforeEach(() => { idx = 0; });
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

interface Row { period: string; scopeLevel: string; scopeId: string; measureId: string; numerator: number; denominator: number; }

test("backfills a snapshot per month, All = Σ tenants, audited before upsert", async () => {
  const summary = await backfillQualityHistory(deps, { months: 3, asOf: "2026-06" });
  assert.equal(summary.months, 3);
  assert.equal(summary.monthsWritten, 3);
  assert.ok(summary.rowsWritten > 0);

  const store = deps.qualitySnapshots;
  const audiogram = (await store.querySnapshots({ measureId: "audiogram" })) as Row[];
  const months = [...new Set(audiogram.map((r) => r.period))].sort();
  assert.deepEqual(months, ["2026-04", "2026-05", "2026-06"]);

  // Reconciliation for one measure/period: the 'all' numerator = Σ tenant numerators.
  const may = audiogram.filter((r) => r.period === "2026-05");
  const all = may.find((r) => r.scopeLevel === "all")!;
  const tenantSum = may.filter((r) => r.scopeLevel === "tenant").reduce((a, r) => a + r.numerator, 0);
  assert.equal(all.numerator, tenantSum);

  const audit = await events.recentAuditEventsByType(QUALITY_HISTORY_BACKFILLED_EVENT, 100);
  assert.equal(audit.length, 3, "one audit event per month");
});

test("resume=true skips already-materialized months (idempotent)", async () => {
  const again = await backfillQualityHistory(deps, { months: 3, asOf: "2026-06" });
  assert.equal(again.monthsSkipped, 3);
  assert.equal(again.monthsWritten, 0);
});

test("resume recomputes a month that is only PARTIALLY materialized (not all measures)", async () => {
  // Pre-seed a single-measure `all` row for a fresh month (as PR-1 would for a one-measure run).
  await deps.qualitySnapshots.upsertSnapshots([
    {
      measureId: "audiogram", period: "2026-03", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-03-31T23:59:59.999Z",
      scopeLevel: "all", scopeId: "ALL", tenantId: null,
      numerator: 1, denominator: 2, compliant: 1, dueSoon: 0, overdue: 1, missingData: 0, excluded: 0,
      sourceRunId: "run-x", computedAt: "2026-03-31T00:00:00.000Z",
    },
  ]);
  const summary = await backfillQualityHistory(deps, { months: 1, asOf: "2026-03" });
  assert.equal(summary.monthsWritten, 1, "an incomplete month is recomputed, not skipped");
  assert.equal(summary.monthsSkipped, 0);
  // Now the month is complete → a rerun skips it.
  const again = await backfillQualityHistory(deps, { months: 1, asOf: "2026-03" });
  assert.equal(again.monthsSkipped, 1);
});
