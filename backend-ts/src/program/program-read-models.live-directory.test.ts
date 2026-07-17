import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeasureScanOptions, OutcomeRecord, OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { QualitySnapshotRow, QualitySnapshotStore } from "../stores/quality-snapshot-store.ts";
import { programOverview, programRiskOutlook, programTopDrivers, programTrend } from "./program-read-models.ts";
import { replaceLiveDirectory } from "../engine/ingress/webchart/live-directory.ts";

const wcRow: OutcomeWithRun = {
  runId: "run-wc-program", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
  runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "wc|program-1", measureId: "audiogram", status: "OVERDUE",
};

function deps(
  rows: OutcomeWithRun[],
  options: {
    byRun?: Record<string, OutcomeRecord[]>;
    measureRows?: OutcomeRecord[];
    snapshots?: QualitySnapshotStore;
    configured?: boolean;
    calls?: { joined: number; byRun: number; measureScan: number; measureScanOptions?: MeasureScanOptions };
  } = {},
) {
  const outcomeStore = {
    listOutcomesWithRun: async () => {
      if (options.calls) options.calls.joined++;
      return rows;
    },
    listOutcomes: async (runId: string) => {
      if (options.calls) options.calls.byRun++;
      return options.byRun?.[runId] ?? [];
    },
    listOutcomesForMeasure: async (_measureId: string, scanOptions?: MeasureScanOptions) => {
      if (options.calls) {
        options.calls.measureScan++;
        options.calls.measureScanOptions = scanOptions;
      }
      return options.measureRows ?? [];
    },
    aggregateScaleRun: async () => [],
  } as unknown as OutcomeStore;
  const runStore = { listRuns: async () => [] } as unknown as RunStore;
  const caseStore = { listCases: async () => [] } as unknown as CaseStore;
  return {
    outcomeStore,
    runStore,
    caseStore,
    qualitySnapshots: options.snapshots,
    webChartEnv: options.configured === false
      ? {}
      : { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" },
  };
}

const snapshot = (period: string): QualitySnapshotRow => ({
  id: `snap-${period}`, measureId: "audiogram", period,
  periodStart: `${period}-01T00:00:00.000Z`, periodEnd: `${period}-28T00:00:00.000Z`,
  scopeLevel: "site", scopeId: "wc|WebChart", tenantId: "wc", numerator: 1, denominator: 1,
  compliant: 1, dueSoon: 0, overdue: 0, missingData: 0, excluded: 0,
  sourceRunId: `run-${period}`, computedAt: `${period}-28T00:00:00.000Z`,
});

test("program read models — restart wc rows survive tenant/site filters and driver tallies", async () => {
  replaceLiveDirectory([]);
  try {
    const overview = await programOverview(deps([wcRow]), { tenant: "wc", site: "WebChart" });
    const audiogram = overview.find((row) => row.measureId === "audiogram")!;
    assert.equal(audiogram.totalEvaluated, 1);
    assert.equal(audiogram.overdue, 1);

    const drivers = await programTopDrivers(deps([wcRow]), "audiogram", { tenant: "wc", site: "WebChart" });
    assert.deepEqual(drivers.bySite, [{ site: "WebChart", overdueCount: 1, note: "High overdue concentration" }]);
    assert.deepEqual(drivers.byRole, [{ role: "employee", overdueCount: 1 }]);
  } finally {
    replaceLiveDirectory([]);
  }
});

test("programTrend — site-only monthly scope rehydrates wc after registry loss before snapshot early return", async () => {
  replaceLiveDirectory([]);
  try {
    const queries: Array<{ scopeId?: string }> = [];
    const snapshots: QualitySnapshotStore = {
      upsertSnapshots: async () => {},
      querySnapshots: async (query) => {
        queries.push(query);
        return [snapshot("2026-06"), snapshot("2026-07")];
      },
    };
    const points = await programTrend(deps([wcRow], { snapshots }), "audiogram", { site: "WebChart" }, { monthly: true });
    assert.equal(queries.length, 1, "monthly snapshot path is selected");
    assert.equal(queries[0]!.scopeId, "wc|WebChart");
    assert.deepEqual(points.map((point) => point.period), ["2026-07", "2026-06"]);
  } finally {
    replaceLiveDirectory([]);
  }
});

test("programTrend — seam-off tenant=wc monthly request falls back without querying persisted wc snapshots", async () => {
  let snapshotQueries = 0;
  const snapshots: QualitySnapshotStore = {
    upsertSnapshots: async () => {},
    querySnapshots: async () => {
      snapshotQueries++;
      return [snapshot("2026-06"), snapshot("2026-07")];
    },
  };
  const d = deps([wcRow], { snapshots, configured: false });

  const expected = await programTrend(d, "audiogram", { tenant: "wc" }, { monthly: false });
  const actual = await programTrend(d, "audiogram", { tenant: "wc" }, { monthly: true });

  assert.deepEqual(actual, expected);
  assert.deepEqual(actual, []);
  assert.equal(snapshotQueries, 0, "seam-off never reads a wc-scoped monthly snapshot");
});

test("programTrend — seam-off All monthly request is byte-equivalent to the wc-filtered per-run path", async () => {
  let snapshotQueries = 0;
  const snapshots: QualitySnapshotStore = {
    upsertSnapshots: async () => {},
    querySnapshots: async () => {
      snapshotQueries++;
      return [snapshot("2026-06"), snapshot("2026-07")];
    },
  };
  const staticRow: OutcomeWithRun = {
    ...wcRow,
    runId: "run-static-program",
    runStartedAt: "2026-07-16T00:00:00.000Z",
    subjectId: "emp-001",
    status: "COMPLIANT",
  };
  const d = deps([wcRow, staticRow], { snapshots, configured: false });

  const expected = await programTrend(d, "audiogram", {}, { monthly: false });
  const actual = await programTrend(d, "audiogram", {}, { monthly: true });

  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.map((point) => point.runId), ["run-static-program"]);
  assert.equal(snapshotQueries, 0, "an All snapshot may contain wc history and is unsafe seam-off");
});

test("programTrend — seam-off static-only All preserves the monthly snapshot query and result", async () => {
  let snapshotQueries = 0;
  const allSnapshots = [
    { ...snapshot("2026-06"), scopeLevel: "all" as const, scopeId: "ALL", tenantId: null },
    { ...snapshot("2026-07"), scopeLevel: "all" as const, scopeId: "ALL", tenantId: null },
  ];
  const snapshots: QualitySnapshotStore = {
    upsertSnapshots: async () => {},
    querySnapshots: async (query) => {
      snapshotQueries++;
      assert.equal(query.scopeLevel, "all");
      assert.equal(query.scopeId, "ALL");
      return allSnapshots;
    },
  };
  const staticRow: OutcomeWithRun = {
    ...wcRow,
    runId: "run-static-only-all",
    subjectId: "emp-001",
    status: "COMPLIANT",
  };

  const actual = await programTrend(
    deps([staticRow], { snapshots, configured: false }),
    "audiogram",
    {},
    { monthly: true },
  );

  assert.deepEqual(actual.map((point) => point.period), ["2026-07", "2026-06"]);
  assert.deepEqual(actual.map((point) => point.runId), ["run-2026-07", "run-2026-06"]);
  assert.equal(snapshotQueries, 1);
});

test("programTrend — seam-off explicit static tenant preserves the monthly snapshot optimization", async () => {
  let snapshotQueries = 0;
  const snapshots: QualitySnapshotStore = {
    upsertSnapshots: async () => {},
    querySnapshots: async (query) => {
      snapshotQueries++;
      assert.equal(query.scopeLevel, "tenant");
      assert.equal(query.scopeId, "twh");
      return [
        { ...snapshot("2026-06"), scopeLevel: "tenant", scopeId: "twh", tenantId: "twh" },
        { ...snapshot("2026-07"), scopeLevel: "tenant", scopeId: "twh", tenantId: "twh" },
      ];
    },
  };
  const staticRow: OutcomeWithRun = {
    ...wcRow,
    runId: "run-static-tenant",
    subjectId: "emp-001",
    status: "COMPLIANT",
  };

  const actual = await programTrend(
    deps([wcRow, staticRow], { snapshots, configured: false }),
    "audiogram",
    { tenant: "twh" },
    { monthly: true },
  );

  assert.deepEqual(actual.map((point) => point.period), ["2026-07", "2026-06"]);
  assert.equal(snapshotQueries, 1);
});

test("program paths — a newer FAILED population run changes no overview, trend, or top-driver state", async () => {
  replaceLiveDirectory([]);
  try {
    const failed: OutcomeWithRun[] = [
      { ...wcRow, runId: "run-wc-failed", runStartedAt: "2026-07-18T00:00:00.000Z", runStatus: "FAILED", status: "COMPLIANT" },
      { ...wcRow, runId: "run-failed-only", runStartedAt: "2026-07-18T00:00:00.000Z", runStatus: "FAILED", subjectId: "wc|failed-only", status: "COMPLIANT" },
    ];
    const d = deps([wcRow, ...failed]);
    const overview = await programOverview(d, { tenant: "wc", site: "WebChart" });
    const audiogram = overview.find((row) => row.measureId === "audiogram")!;
    assert.equal(audiogram.latestRunId, wcRow.runId);
    assert.equal(audiogram.totalEvaluated, 1);
    assert.equal(audiogram.overdue, 1);
    assert.equal(audiogram.compliant, 0);

    const trend = await programTrend(d, "audiogram", { tenant: "wc", site: "WebChart" });
    assert.deepEqual(trend.map((point) => point.runId), [wcRow.runId]);
    const drivers = await programTopDrivers(d, "audiogram", { tenant: "wc", site: "WebChart" });
    assert.deepEqual(drivers.bySite, [{ site: "WebChart", overdueCount: 1, note: "High overdue concentration" }]);
  } finally {
    replaceLiveDirectory([]);
  }
});

test("programRiskOutlook — successful wc history rehydrates raw name and a newer FAILED row is invisible", async () => {
  replaceLiveDirectory([]);
  try {
    const subjectId = "wc|risk-restart-1";
    const completedRows: OutcomeRecord[] = ["2024-01-01", "2025-01-01", "2026-01-01"].map((period, index) => ({
      id: `out-ok-${index}`, runId: "run-risk-ok", subjectId, measureId: "audiogram", evaluationPeriod: period,
      status: "OVERDUE", evidence: {}, evaluatedAt: `${period}T00:00:00.000Z`,
    }));
    const failedRow: OutcomeRecord = {
      id: "out-failed", runId: "run-risk-failed", subjectId, measureId: "audiogram", evaluationPeriod: "2026-01-01",
      status: "COMPLIANT", evidence: {}, evaluatedAt: "2026-07-18T00:00:00.000Z",
    };
    const failedOnlyRow: OutcomeRecord = {
      id: "out-failed-only", runId: "run-risk-failed", subjectId: "wc|failed-risk-only", measureId: "audiogram",
      evaluationPeriod: "2026-01-01", status: "COMPLIANT", evidence: {}, evaluatedAt: "2026-07-18T00:00:01.000Z",
    };
    const joined: OutcomeWithRun[] = [
      ...completedRows.map((row) => ({
        runId: row.runId, runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE", runStatus: "COMPLETED",
        runTriggeredBy: "manual", subjectId: row.subjectId, measureId: row.measureId, status: row.status,
      })),
      {
        runId: failedRow.runId, runStartedAt: "2026-07-18T00:00:00.000Z", runScopeType: "MEASURE", runStatus: "FAILED",
        runTriggeredBy: "manual", subjectId, measureId: "audiogram", status: "COMPLIANT",
      },
      {
        runId: failedOnlyRow.runId, runStartedAt: "2026-07-18T00:00:00.000Z", runScopeType: "MEASURE", runStatus: "FAILED",
        runTriggeredBy: "manual", subjectId: failedOnlyRow.subjectId, measureId: "audiogram", status: "COMPLIANT",
      },
    ];
    const calls = { joined: 0, byRun: 0, measureScan: 0 };
    const outlook = await programRiskOutlook(
      deps(joined, {
        byRun: { "run-risk-ok": completedRows, "run-risk-failed": [failedRow, failedOnlyRow] },
        measureRows: completedRows,
        calls,
      }),
      "audiogram",
      30,
    );
    assert.ok(outlook);
    assert.deepEqual(outlook!.siteComplianceRates, [{
      site: "WebChart", total: 1, compliant: 0, upcomingExpirations: 0, currentComplianceRate: 0, predictedComplianceRate: 0,
    }]);
    assert.deepEqual(outlook!.repeatNonCompliers, [{
      externalId: subjectId, name: "risk-restart-1", site: "WebChart", measureName: "Annual Audiogram Completed", streakCount: 3,
    }]);
    assert.deepEqual(calls, {
      joined: 0,
      byRun: 0,
      measureScan: 1,
      measureScanOptions: { excludeScale: true, successfulPopulationOnly: true },
    }, "risk performs one evidence-rich successful-population scan and no per-run hydration");
  } finally {
    replaceLiveDirectory([]);
  }
});
