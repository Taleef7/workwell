/**
 * UX-8 — monthly-snapshot program trend. Unit-tests the two pure helpers + the monthly/fallback
 * wiring in programTrend.
 *   node --import tsx --test src/program/program-trend.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Task 2 adds `monthlyTrendPoints` and Task 3 adds `programDeps`/`ProgramDeps` + `programTrend` to this
// import as those tasks are implemented. Task 1 uses only `snapshotScopeFor`.
import { snapshotScopeFor, monthlyTrendPoints, programTrend, isWholeMonthRange, complianceRateOf } from "./program-read-models.ts";
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

test("monthlyTrendPoints — newest-first order, stamps period, rate = complianceRateOf (denominator-based)", () => {
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

test("monthlyTrendPoints — rate uses CMS denominator (excluded removed), stamps denominator", () => {
  // compliant=8, dueSoon=0, overdue=1, missingData=0, excluded=1 → numerator=8, denominator=9, total=10.
  // Updated to CMS rate: compliant / (total - excluded) = 8 / (10 - 1) = 88.9% with excluded removed from denominator.
  const withExcluded: QualitySnapshotRow = {
    ...snap("2026-06", 8, 9), // numerator=8, denominator=9 (deliberately != total)
    compliant: 8,
    dueSoon: 0,
    overdue: 1,
    missingData: 0,
    excluded: 1,
  };
  const [pt] = monthlyTrendPoints([withExcluded]);
  assert.equal(pt!.totalEvaluated, 10); // evaluated count keeps all 5 buckets
  assert.equal(pt!.denominator, 9); // total - excluded
  assert.equal(pt!.complianceRate, 88.9); // 8/9, not 8/10
});

test("complianceRateOf — pins CMS denominator (e.g. 38 compliant, 7 overdue, 3 excluded -> 84.4)", () => {
  assert.equal(complianceRateOf({ compliant: 38, dueSoon: 0, overdue: 7, missingData: 0, excluded: 3 }), 84.4);
  assert.equal(complianceRateOf({ compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, excluded: 5 }), 0); // 0 when denominator is 0
});

// Minimal fakes: programTrend only touches outcomeStore.listOutcomesWithRun (per-run path) and
// qualitySnapshots.querySnapshots (monthly path). runStore/caseStore are unused by programTrend.
function fakeDeps(opts: { snaps?: QualitySnapshotRow[]; perRun?: OutcomeWithRun[]; withSnapshots?: boolean }): ProgramDeps {
  const deps = {
    runStore: {} as ProgramDeps["runStore"],
    caseStore: {} as ProgramDeps["caseStore"],
    outcomeStore: { listOutcomesWithRun: async () => opts.perRun ?? [] } as unknown as ProgramDeps["outcomeStore"],
  } as ProgramDeps;
  deps.webChartEnv = { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" };
  if (opts.withSnapshots !== false) {
    deps.qualitySnapshots = { querySnapshots: async () => opts.snaps ?? [], upsertSnapshots: async () => {} };
  }
  return deps;
}

const perRunRow = (runId: string, startedAt: string, status: string, runStatus = "COMPLETED"): OutcomeWithRun => ({
  runId, runStartedAt: startedAt, runScopeType: "ALL_PROGRAMS", runStatus, runTriggeredBy: "manual",
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

test("isWholeMonthRange — unbounded / month-aligned true; partial-month false", () => {
  assert.equal(isWholeMonthRange(undefined, undefined), true); // no range
  assert.equal(isWholeMonthRange("2026-06-01", "2026-07-31"), true); // whole June+July
  assert.equal(isWholeMonthRange("2026-02-01", "2026-02-28"), true); // Feb (28-day month) last day
  assert.equal(isWholeMonthRange("2026-06-01", undefined), true); // open-ended from a month start
  assert.equal(isWholeMonthRange(undefined, "2026-06-30"), true); // open-ended to a month end
  assert.equal(isWholeMonthRange("2026-06-27", "2026-07-04"), false); // partial both ends
  assert.equal(isWholeMonthRange("2026-06-01", "2026-07-15"), false); // partial upper (July not full)
  assert.equal(isWholeMonthRange("2026-06-15", "2026-07-31"), false); // partial lower (June not full)
  assert.equal(isWholeMonthRange("2026-02-01", "2026-02-27"), false); // Feb 27 is not the last day
});

test("programTrend — partial-month range → per-run fallback even with ≥2 snapshots (Codex P2)", async () => {
  // A range that cuts through month boundaries can't be honored by a month-granular series, so the
  // trend must fall back to the day-granular per-run path rather than widen to whole months.
  const deps = fakeDeps({
    snaps: [snap("2026-06", 9, 10), snap("2026-07", 8, 10)],
    perRun: [perRunRow("run-a", "2026-06-28T00:00:00Z", "COMPLIANT"), perRunRow("run-b", "2026-06-30T00:00:00Z", "OVERDUE")],
  });
  const pts = await programTrend(deps, "audiogram", { from: "2026-06-27", to: "2026-07-04" }, { monthly: true });
  assert.ok(pts.every((p) => p.period === undefined), "partial-month range falls back to per-run");
  assert.deepEqual(new Set(pts.map((p) => p.runId)), new Set(["run-a", "run-b"]));
});

test("programTrend — collapses to at most one point per calendar day, keeping the later completed run", async () => {
  const deps = fakeDeps({
    withSnapshots: false,
    perRun: [
      perRunRow("run-early", "2026-06-01T09:00:00Z", "COMPLIANT"),
      perRunRow("run-late", "2026-06-01T15:00:00Z", "OVERDUE"),
      perRunRow("run-next-day", "2026-06-02T10:00:00Z", "COMPLIANT"),
    ],
  });
  const pts = await programTrend(deps, "audiogram", {});
  assert.equal(pts.length, 2, "collapsed two runs on 2026-06-01 to one");
  assert.equal(pts[0]!.runId, "run-next-day", "newest first");
  assert.equal(pts[1]!.runId, "run-late", "later completed run of 2026-06-01 kept");
});

test("programTrend — a PARTIAL_FAILURE run is a trend point; a FAILED/QUEUED run is not", async () => {
  const deps = fakeDeps({
    withSnapshots: false,
    perRun: [
      perRunRow("run-completed", "2026-06-01T09:00:00Z", "COMPLIANT", "COMPLETED"),
      perRunRow("run-partial", "2026-06-02T10:00:00Z", "OVERDUE", "PARTIAL_FAILURE"),
      perRunRow("run-failed", "2026-06-03T15:00:00Z", "OVERDUE", "FAILED"),
      perRunRow("run-queued", "2026-06-04T12:00:00Z", "OVERDUE", "QUEUED"),
    ],
  });
  const pts = await programTrend(deps, "audiogram", {});
  assert.equal(pts.length, 2, "PARTIAL_FAILURE and COMPLETED are trend points; FAILED/QUEUED are not");
  assert.deepEqual(pts.map((p) => p.runId), ["run-partial", "run-completed"]);
});

test("programTrend — per-run points include denominator and CMS compliance rate", async () => {
  // 38 compliant, 7 overdue, 3 excluded -> total 48, denominator 45, rate 84.4
  const rows: OutcomeWithRun[] = [];
  for (let i = 0; i < 38; i++) rows.push(perRunRow("run-cms", "2026-06-01T12:00:00Z", "COMPLIANT"));
  for (let i = 0; i < 7; i++) rows.push(perRunRow("run-cms", "2026-06-01T12:00:00Z", "OVERDUE"));
  for (let i = 0; i < 3; i++) rows.push(perRunRow("run-cms", "2026-06-01T12:00:00Z", "EXCLUDED"));

  const deps = fakeDeps({ withSnapshots: false, perRun: rows });
  const pts = await programTrend(deps, "audiogram", {});
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.totalEvaluated, 48);
  assert.equal(pts[0]!.denominator, 45);
  assert.equal(pts[0]!.complianceRate, 84.4);
});

test("programTrend — timezone-correct day collapse (Pacific/Honolulu collapses across UTC midnight, invalid tz falls back to UTC)", async () => {
  const deps = fakeDeps({
    withSnapshots: false,
    perRun: [
      perRunRow("run-hst-early", "2026-09-02T23:30:00.000Z", "COMPLIANT"),
      perRunRow("run-hst-late", "2026-09-03T01:30:00.000Z", "OVERDUE"),
    ],
  });

  // tz=Pacific/Honolulu: 23:30Z is 13:30 HST, 01:30Z is 15:30 HST -> both on 2026-09-02 local day.
  // Collapses to ONE point, keeping the later run (run-hst-late).
  const hstPts = await programTrend(deps, "audiogram", {}, { tz: "Pacific/Honolulu" });
  assert.equal(hstPts.length, 1, "Pacific/Honolulu collapses to 1 point");
  assert.equal(hstPts[0]!.runId, "run-hst-late", "keeps the later run of that local day");

  // UTC: 2026-09-02 and 2026-09-03 are distinct UTC days -> TWO points.
  const utcPts = await programTrend(deps, "audiogram", {}, { tz: "UTC" });
  assert.equal(utcPts.length, 2, "UTC produces 2 points");

  // Default (no tz specified): behaves as UTC -> TWO points.
  const defPts = await programTrend(deps, "audiogram", {});
  assert.equal(defPts.length, 2, "default tz produces 2 points");

  // Invalid tz: falls back to UTC -> TWO points.
  const invalidPts = await programTrend(deps, "audiogram", {}, { tz: "Invalid/Timezone" });
  assert.equal(invalidPts.length, 2, "invalid tz falls back to UTC (2 points)");
});
