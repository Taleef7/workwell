/**
 * UX-8 — monthly-snapshot program trend. Unit-tests the two pure helpers + the monthly/fallback
 * wiring in programTrend.
 *   node --import tsx --test src/program/program-trend.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Task 2 adds `monthlyTrendPoints` and Task 3 adds `programDeps`/`ProgramDeps` + `programTrend` to this
// import as those tasks are implemented. Task 1 uses only `snapshotScopeFor`.
import { snapshotScopeFor, monthlyTrendPoints, programTrend } from "./program-read-models.ts";
import type { ProgramDeps } from "./program-read-models.ts";
import type { QualitySnapshotRow } from "../stores/quality-snapshot-store.ts";
import type { OutcomeWithRun } from "../stores/outcome-store.ts";

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

test("monthlyTrendPoints — newest-first order, stamps period, rate = round1(compliant,total)", () => {
  const pts = monthlyTrendPoints([snap("2026-06", 8, 10), snap("2026-04", 5, 10), snap("2026-05", 9, 10)]);
  assert.deepEqual(pts.map((p) => p.period), ["2026-06", "2026-05", "2026-04"]); // newest-first
  assert.equal(pts[0]!.complianceRate, 80); // 8/10 (newest = 2026-06)
  assert.equal(pts[0]!.totalEvaluated, 10); // total-including-excluded
  assert.equal(pts[0]!.startedAt, "2026-06-28T00:00:00.000Z"); // periodEnd
  assert.equal(pts[2]!.overdue, 5); // bucket carried through (oldest = 2026-04)
});

test("monthlyTrendPoints — caps to the newest 12 months (newest-first)", () => {
  // 15 distinct months 2025-01 … 2026-03; expect only the newest 12 (2025-04 … 2026-03).
  const many = Array.from({ length: 15 }, (_, i) =>
    snap(`20${25 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, 1, 2),
  );
  const pts = monthlyTrendPoints(many);
  assert.equal(pts.length, 12);
  assert.equal(pts[0]!.period, "2026-03"); // newest
  assert.equal(pts[11]!.period, "2025-04"); // oldest kept
});

test("monthlyTrendPoints — rate uses total-including-excluded, not the E16 denominator", () => {
  // compliant=8, dueSoon=0, overdue=1, missingData=0, excluded=1 → numerator=8, denominator=9, total=10.
  // The per-run path + /programs headline use compliant/total (=80%), NOT numerator/denominator (~88.9%).
  const withExcluded: QualitySnapshotRow = {
    ...snap("2026-06", 8, 9), // numerator=8, denominator=9 (deliberately != total)
    compliant: 8,
    dueSoon: 0,
    overdue: 1,
    missingData: 0,
    excluded: 1,
  };
  const [pt] = monthlyTrendPoints([withExcluded]);
  assert.equal(pt!.totalEvaluated, 10); // 8+0+1+0+1, not the denominator 9
  assert.equal(pt!.complianceRate, 80); // 8/10, not 8/9
});

// Minimal fakes: programTrend only touches outcomeStore.listOutcomesWithRun (per-run path) and
// qualitySnapshots.querySnapshots (monthly path). runStore/caseStore are unused by programTrend.
function fakeDeps(opts: { snaps?: QualitySnapshotRow[]; perRun?: OutcomeWithRun[]; withSnapshots?: boolean }): ProgramDeps {
  const deps = {
    runStore: {} as ProgramDeps["runStore"],
    caseStore: {} as ProgramDeps["caseStore"],
    outcomeStore: { listOutcomesWithRun: async () => opts.perRun ?? [] } as unknown as ProgramDeps["outcomeStore"],
  } as ProgramDeps;
  if (opts.withSnapshots !== false) {
    deps.qualitySnapshots = { querySnapshots: async () => opts.snaps ?? [], upsertSnapshots: async () => {} };
  }
  return deps;
}

const perRunRow = (runId: string, startedAt: string, status: string): OutcomeWithRun => ({
  runId, runStartedAt: startedAt, runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual",
  subjectId: "emp-006", measureId: "audiogram", status,
});

test("programTrend — ≥2 monthly snapshots → monthly points (period stamped)", async () => {
  const deps = fakeDeps({ snaps: [snap("2026-05", 9, 10), snap("2026-06", 8, 10)] });
  const pts = await programTrend(deps, "audiogram", {}, { monthly: true });
  assert.equal(pts.length, 2);
  assert.equal(pts[0]!.period, "2026-06"); // newest-first
  assert.equal(pts[0]!.complianceRate, 80); // 8/10 (2026-06)
});

test("programTrend — monthly opt-out (default) → per-run even with snapshots present", async () => {
  // ≥2 snapshots available, but no { monthly: true } → the measure-page consumer stays per-run.
  const deps = fakeDeps({
    snaps: [snap("2026-05", 9, 10), snap("2026-06", 8, 10)],
    perRun: [perRunRow("run-a", "2026-06-01T00:00:00Z", "COMPLIANT")],
  });
  const pts = await programTrend(deps, "audiogram", {}); // opt-in not requested
  assert.ok(pts.every((p) => p.period === undefined), "opt-out points carry no period");
  assert.deepEqual(new Set(pts.map((p) => p.runId)), new Set(["run-a"]));
});

test("programTrend — <2 monthly snapshots → per-run fallback (no period)", async () => {
  const deps = fakeDeps({
    snaps: [snap("2026-06", 8, 10)], // only 1 month
    perRun: [perRunRow("run-a", "2026-06-01T00:00:00Z", "COMPLIANT"), perRunRow("run-b", "2026-06-02T00:00:00Z", "OVERDUE")],
  });
  const pts = await programTrend(deps, "audiogram", {}, { monthly: true });
  assert.ok(pts.every((p) => p.period === undefined), "fallback points carry no period");
  assert.deepEqual(new Set(pts.map((p) => p.runId)), new Set(["run-a", "run-b"]));
});

test("programTrend — no qualitySnapshots dep → per-run (back-compat)", async () => {
  const deps = fakeDeps({ withSnapshots: false, perRun: [perRunRow("run-a", "2026-06-01T00:00:00Z", "COMPLIANT")] });
  const pts = await programTrend(deps, "audiogram", {}, { monthly: true });
  assert.ok(pts.every((p) => p.period === undefined));
});
