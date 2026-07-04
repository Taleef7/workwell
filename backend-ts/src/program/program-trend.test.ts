/**
 * UX-8 — monthly-snapshot program trend. Unit-tests the two pure helpers + the monthly/fallback
 * wiring in programTrend.
 *   node --import tsx --test src/program/program-trend.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Task 2 adds `monthlyTrendPoints` and Task 3 adds `programDeps`/`ProgramDeps` + `programTrend` to this
// import as those tasks are implemented. Task 1 uses only `snapshotScopeFor`.
import { snapshotScopeFor, monthlyTrendPoints } from "./program-read-models.ts";
import type { QualitySnapshotRow } from "../stores/quality-snapshot-store.ts";

test("snapshotScopeFor — no tenant/site → all/ALL", () => {
  assert.deepEqual(snapshotScopeFor({}), { scopeLevel: "all", scopeId: "ALL" });
});

test("snapshotScopeFor — tenant only → tenant/<id>", () => {
  assert.deepEqual(snapshotScopeFor({ tenant: "ihn" }), { scopeLevel: "tenant", scopeId: "ihn" });
});

test("snapshotScopeFor — tenant + site → site/<tenant|site>", () => {
  assert.deepEqual(snapshotScopeFor({ tenant: "twh", site: "Plant A" }), { scopeLevel: "site", scopeId: "twh|Plant A" });
});

test("snapshotScopeFor — site alone resolves its tenant from the directory", () => {
  // "Plant A" belongs to twh in the synthetic directory → resolves uniquely.
  assert.deepEqual(snapshotScopeFor({ site: "Plant A" }), { scopeLevel: "site", scopeId: "twh|Plant A" });
});

test("snapshotScopeFor — unknown site (no tenant) → null (fall back to per-run)", () => {
  assert.equal(snapshotScopeFor({ site: "Nowhere" }), null);
});

const snap = (period: string, num: number, den: number): QualitySnapshotRow => ({
  id: `snap-${period}`,
  measureId: "audiogram",
  period,
  periodStart: `${period}-01T00:00:00.000Z`,
  periodEnd: `${period}-28T00:00:00.000Z`,
  scopeLevel: "all",
  scopeId: "ALL",
  tenantId: null,
  numerator: num,
  denominator: den,
  compliant: num,
  dueSoon: 0,
  overdue: den - num,
  missingData: 0,
  excluded: 0,
  sourceRunId: `run-${period}`,
  computedAt: `${period}-28T00:00:00.000Z`,
});

test("monthlyTrendPoints — maps rows chronologically, stamps period, rate = round1(num,den)", () => {
  const pts = monthlyTrendPoints([snap("2026-06", 8, 10), snap("2026-04", 5, 10), snap("2026-05", 9, 10)]);
  assert.deepEqual(pts.map((p) => p.period), ["2026-04", "2026-05", "2026-06"]);
  assert.equal(pts[2]!.complianceRate, 80); // 8/10
  assert.equal(pts[2]!.totalEvaluated, 10); // denominator
  assert.equal(pts[2]!.startedAt, "2026-06-28T00:00:00.000Z"); // periodEnd
  assert.equal(pts[0]!.overdue, 5); // bucket carried through
});

test("monthlyTrendPoints — caps to the newest 12 months", () => {
  // 15 distinct months 2025-01 … 2026-03; expect only the newest 12 (2025-04 … 2026-03).
  const many = Array.from({ length: 15 }, (_, i) =>
    snap(`20${25 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, 1, 2),
  );
  const pts = monthlyTrendPoints(many);
  assert.equal(pts.length, 12);
  assert.equal(pts[0]!.period, "2025-04");
  assert.equal(pts[11]!.period, "2026-03");
});
