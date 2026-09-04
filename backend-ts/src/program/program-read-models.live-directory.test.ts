import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";
import type { MeasureScanOptions, OutcomeRecord, OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseRecord, CaseStore } from "../stores/case-store.ts";
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
    cases?: CaseRecord[];
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
  const caseStore = { listCases: async () => options.cases ?? [] } as unknown as CaseStore;
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

test("programRiskOutlook — routes per-site rates through complianceRateOf (38/7/3 -> 84.4)", async () => {
  const measureRows: OutcomeRecord[] = [];
  for (let i = 0; i < 38; i++) {
    measureRows.push({
      id: `out-c-${i}`, runId: "run-pin", subjectId: `wc|pin-c-${i}`, measureId: "audiogram",
      evaluationPeriod: "2026-01-01", status: "COMPLIANT", evidence: {}, evaluatedAt: "2026-07-17T00:00:00.000Z",
    });
  }
  for (let i = 0; i < 7; i++) {
    measureRows.push({
      id: `out-o-${i}`, runId: "run-pin", subjectId: `wc|pin-o-${i}`, measureId: "audiogram",
      evaluationPeriod: "2026-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2026-07-17T00:00:00.000Z",
    });
  }
  for (let i = 0; i < 3; i++) {
    measureRows.push({
      id: `out-e-${i}`, runId: "run-pin", subjectId: `wc|pin-e-${i}`, measureId: "audiogram",
      evaluationPeriod: "2026-01-01", status: "EXCLUDED", evidence: {}, evaluatedAt: "2026-07-17T00:00:00.000Z",
    });
  }
  const outlook = await programRiskOutlook(deps([], { measureRows }), "audiogram", 30);
  assert.ok(outlook);
  assert.equal(outlook.siteComplianceRates.length, 1);
  assert.equal(outlook.siteComplianceRates[0]!.total, 48);
  assert.equal(outlook.siteComplianceRates[0]!.compliant, 38);
  assert.equal(outlook.siteComplianceRates[0]!.currentComplianceRate, 84.4);
});

test("default profile — non-catalog subjects (e.g. QRDA Cypress imports) are included in read models", async () => {
  const nonCatalogSubjectId = "cypress-mrn-non-catalog-99";
  const row: OutcomeWithRun = {
    runId: "run-cypress-1",
    runStartedAt: "2026-07-17T00:00:00.000Z",
    runScopeType: "MEASURE",
    runStatus: "COMPLETED",
    runTriggeredBy: "manual",
    subjectId: nonCatalogSubjectId,
    measureId: "audiogram",
    status: "COMPLIANT",
  };
  const caseRec: CaseRecord = {
    id: "case-cypress-1",
    employeeId: nonCatalogSubjectId,
    measureId: "audiogram",
    evaluationPeriod: "2026-01-01",
    status: "OPEN",
    priority: "HIGH",
    assignee: null,
    nextAction: null,
    currentOutcomeStatus: "COMPLIANT",
    lastRunId: "run-cypress-1",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    closedAt: null,
    closedReason: null,
    closedBy: null,
  };

  const measureRow: OutcomeRecord = {
    id: "out-cypress-1",
    runId: "run-cypress-1",
    subjectId: nonCatalogSubjectId,
    measureId: "audiogram",
    evaluationPeriod: "2026-01-01",
    status: "COMPLIANT",
    evidence: {},
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  };

  const d = deps([row], { cases: [caseRec], measureRows: [measureRow] });
  const overview = await programOverview(d, {});
  const audiogram = overview.find((m) => m.measureId === "audiogram")!;
  assert.equal(audiogram.totalEvaluated, 1, "unresolved QRDA subject must be evaluated on default profile");
  assert.equal(audiogram.compliant, 1, "unresolved QRDA subject contributes to compliant total on default profile");
  assert.equal(audiogram.openCaseCount, 1, "unresolved QRDA subject open case must be counted on default profile");

  const trend = await programTrend(d, "audiogram", {});
  assert.equal(trend.length, 1);
  assert.equal(trend[0]!.totalEvaluated, 1);
  assert.equal(trend[0]!.compliant, 1);

  const outlook = await programRiskOutlook(d, "audiogram", 30);
  assert.ok(outlook);
  const unknownSite = outlook!.siteComplianceRates.find((s) => s.site === "Unknown");
  assert.equal(unknownSite?.total, 1, "unresolved QRDA subject is included in risk outlook under Unknown site on default profile");
});

test("scoped profile (Maui) — isolates data by excluding foreign and unresolved subjects from read models", () => {
  const output = runProfileChild("maui", `
    import { programOverview, programRiskOutlook, programTrend } from "./src/program/program-read-models.ts";

    const recentExam = new Date(Date.now() - 320 * 86400000).toISOString().slice(0, 10);

    const mauiRow = {
      runId: "run-maui-1", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "pat-001", measureId: "cms122",
      evaluationPeriod: "2026-01-01", status: "COMPLIANT",
      evidence: { expressionResults: [{ define: "Most Recent Exam Date", result: recentExam }] },
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    };
    const twhRow = {
      runId: "run-maui-1", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "emp-001", measureId: "cms122",
      evaluationPeriod: "2026-01-01", status: "OVERDUE", evidence: {},
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    };
    const unresolvableRow = {
      runId: "run-maui-1", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "cypress-mrn-foreign", measureId: "cms122",
      evaluationPeriod: "2026-01-01", status: "COMPLIANT",
      evidence: { expressionResults: [{ define: "Most Recent Exam Date", result: recentExam }] },
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    };
    const liveWcRow = {
      runId: "run-maui-1", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "wc|maui-live-1", measureId: "cms122",
      evaluationPeriod: "2026-01-01", status: "COMPLIANT", evidence: {},
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    };

    const twhStreakRows = ["2024-01-01", "2025-01-01", "2026-01-01"].map((period, index) => ({
      id: \`out-twh-\${index}\`, runId: "run-maui-1", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "emp-001", measureId: "cms122", evaluationPeriod: period,
      status: "OVERDUE", evidence: {}, evaluatedAt: \`\${period}T00:00:00.000Z\`,
    }));

    const mauiCase = {
      id: "case-1", employeeId: "pat-001", measureId: "cms122", status: "OPEN", createdAt: "2026-07-17T00:00:00.000Z",
    };
    const twhCase = {
      id: "case-2", employeeId: "emp-001", measureId: "cms122", status: "OPEN", createdAt: "2026-07-17T00:00:00.000Z",
    };
    const unresolvableCase = {
      id: "case-3", employeeId: "cypress-mrn-foreign", measureId: "cms122", status: "OPEN", createdAt: "2026-07-17T00:00:00.000Z",
    };

    const rows = [mauiRow, twhRow, unresolvableRow, liveWcRow];
    const riskRows = [mauiRow, ...twhStreakRows, unresolvableRow, liveWcRow];
    const cases = [mauiCase, twhCase, unresolvableCase];

    const fakeDeps = {
      outcomeStore: {
        listOutcomesWithRun: async () => rows,
        listOutcomesForMeasure: async () => riskRows,
        aggregateScaleRun: async () => [],
      },
      runStore: { listRuns: async () => [] },
      caseStore: { listCases: async () => cases },
      webChartEnv: { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" },
    };

    const overview = await programOverview(fakeDeps, {});
    const cms122 = overview.find((m) => m.measureId === "cms122");
    const trend = await programTrend(fakeDeps, "cms122", {});
    const outlook = await programRiskOutlook(fakeDeps, "cms122", 30);

    console.log(JSON.stringify({
      overviewMeasures: overview.map((m) => m.measureId),
      totalEvaluated: cms122?.totalEvaluated,
      compliant: cms122?.compliant,
      overdue: cms122?.overdue,
      openCaseCount: cms122?.openCaseCount,
      trendPoints: trend.map((p) => ({ totalEvaluated: p.totalEvaluated, compliant: p.compliant, overdue: p.overdue })),
      outlookSiteRates: outlook?.siteComplianceRates,
      outlookRepeatNonCompliers: outlook?.repeatNonCompliers,
      outlookUpcomingExpirations: outlook?.upcomingExpirations,
    }));
  `);

  assert.deepEqual(output.overviewMeasures, ["cms125", "cms122", "hypertension"], "Maui profile overview only includes runnable measures");
  assert.equal(output.totalEvaluated, 2, "only Maui-resolvable subjects (pat-001 and wc|) contribute to totalEvaluated");
  assert.equal(output.compliant, 2, "both pat-001 and wc| are COMPLIANT");
  assert.equal(output.overdue, 0, "non-Maui overdue subjects emp-001 and cypress-mrn-foreign must be excluded");
  assert.equal(output.openCaseCount, 1, "only the Maui subject's open case is counted");
  assert.deepEqual(output.trendPoints, [{ totalEvaluated: 2, compliant: 2, overdue: 0 }]);

  const siteRates = output.outlookSiteRates as Array<{ site: string; total: number; compliant: number }>;
  assert.equal(siteRates.some((s) => s.site === "Unknown"), false, "foreign and unresolvable subjects must not produce an Unknown site in risk outlook");
  const wailuku = siteRates.find((s) => s.site === "Wailuku Clinic");
  assert.ok(wailuku, "Maui-resolvable subject pat-001 site must be present in risk outlook");
  assert.equal(wailuku.total, 1, "Maui-resolvable subject is counted in its site");
  assert.equal(wailuku.compliant, 1);

  const repeatNonCompliers = output.outlookRepeatNonCompliers as Array<{ externalId: string }>;
  assert.equal(repeatNonCompliers.some((r) => r.externalId === "emp-001" || r.externalId === "cypress-mrn-foreign"), false, "foreign subjects must not appear in repeatNonCompliers");
  const upcomingExpirations = output.outlookUpcomingExpirations as Array<{ externalId: string }>;
  assert.equal(upcomingExpirations.length, 1, "Maui-resolvable subject must appear in upcomingExpirations");
  assert.equal(upcomingExpirations[0]?.externalId, "pat-001");
  assert.equal(upcomingExpirations.some((u) => u.externalId === "emp-001" || u.externalId === "cypress-mrn-foreign"), false, "foreign subjects must not appear in upcomingExpirations");
});

test("foldScaleCounts — completed seed:scale run skipped on Maui profile and folded on default profile", () => {
  const source = `
    import { programOverview } from "./src/program/program-read-models.ts";

    const mauiRow = {
      runId: "run-maui-1", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "pat-001", measureId: "cms122", status: "COMPLIANT",
    };
    const scaleRun = {
      id: "run-scale-1", scopeId: "cms122", triggeredBy: "seed:scale", status: "COMPLETED",
      startedAt: "2026-07-17T00:00:00.000Z", scopeType: "MEASURE",
    };
    const fakeDeps = {
      outcomeStore: {
        listOutcomesWithRun: async () => [mauiRow],
        aggregateScaleRun: async () => [
          { status: "COMPLIANT", count: 50 },
          { status: "OVERDUE", count: 10 },
        ],
      },
      runStore: {
        listRuns: async () => [scaleRun],
      },
      caseStore: { listCases: async () => [] },
      webChartEnv: { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" },
    };

    const overview = await programOverview(fakeDeps, {});
    const cms122 = overview.find((m) => m.measureId === "cms122");
    console.log(JSON.stringify({
      totalEvaluated: cms122?.totalEvaluated,
      compliant: cms122?.compliant,
      overdue: cms122?.overdue,
      latestRunId: cms122?.latestRunId,
    }));
  `;

  const mauiOutput = runProfileChild("maui", source);
  assert.equal(mauiOutput.totalEvaluated, 1, "Maui profile must not fold scale counts into summary totalEvaluated");
  assert.equal(mauiOutput.compliant, 1, "Maui profile must not fold scale counts into summary compliant");
  assert.equal(mauiOutput.overdue, 0, "Maui profile must not fold scale counts into summary overdue");

  const defaultOutput = runProfileChild(undefined, source);
  assert.equal(defaultOutput.totalEvaluated, 61, "default profile must fold scale counts into summary totalEvaluated (1 live + 60 scale)");
  assert.equal(defaultOutput.compliant, 51, "default profile must fold scale counts into summary compliant (1 live + 50 scale)");
  assert.equal(defaultOutput.overdue, 10, "default profile must fold scale counts into summary overdue (0 live + 10 scale)");
});

test("programTrend — monthly snapshot scope fallback on Maui profile and snapshot series on default profile", () => {
  const source = `
    import { programTrend } from "./src/program/program-read-models.ts";

    const mauiRow = {
      runId: "run-maui-per-run-1", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "pat-001", measureId: "cms122", status: "COMPLIANT",
    };
    const allSnapshots = [
      {
        id: "snap-2026-06", measureId: "cms122", period: "2026-06",
        periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-06-30T00:00:00.000Z",
        scopeLevel: "all", scopeId: "ALL", tenantId: null, numerator: 80, denominator: 100,
        compliant: 80, dueSoon: 0, overdue: 20, missingData: 0, excluded: 0,
        sourceRunId: "run-snap-2026-06", computedAt: "2026-06-30T00:00:00.000Z",
      },
      {
        id: "snap-2026-07", measureId: "cms122", period: "2026-07",
        periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T00:00:00.000Z",
        scopeLevel: "all", scopeId: "ALL", tenantId: null, numerator: 90, denominator: 100,
        compliant: 90, dueSoon: 0, overdue: 10, missingData: 0, excluded: 0,
        sourceRunId: "run-snap-2026-07", computedAt: "2026-07-31T00:00:00.000Z",
      },
    ];
    let snapshotQueried = false;
    const fakeDeps = {
      outcomeStore: {
        listOutcomesWithRun: async () => [mauiRow],
      },
      runStore: { listRuns: async () => [] },
      caseStore: { listCases: async () => [] },
      qualitySnapshots: {
        querySnapshots: async () => {
          snapshotQueried = true;
          return allSnapshots;
        },
        upsertSnapshots: async () => {},
      },
      webChartEnv: { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" },
    };

    const trend = await programTrend(fakeDeps, "cms122", {}, { monthly: true });
    console.log(JSON.stringify({
      trend,
      snapshotQueried,
    }));
  `;

  const mauiOutput = runProfileChild("maui", source);
  const mauiTrend = mauiOutput.trend as Array<{ runId: string; period?: string; totalEvaluated: number; compliant: number }>;
  assert.equal(mauiTrend.length, 1, "Maui profile must return per-run series (1 point)");
  assert.equal(mauiTrend[0]!.runId, "run-maui-per-run-1", "Maui profile must return per-run runId");
  assert.equal(mauiTrend[0]!.period, undefined, "Maui profile fallback points must carry no period");
  assert.equal(mauiTrend[0]!.totalEvaluated, 1, "Maui profile must evaluate only profile-isolated subjects");
  assert.equal(mauiTrend[0]!.compliant, 1);

  const defaultOutput = runProfileChild(undefined, source);
  const defaultTrend = defaultOutput.trend as Array<{ runId: string; period?: string; totalEvaluated: number; compliant: number }>;
  assert.equal(defaultTrend.length, 2, "default profile must return monthly snapshot series (2 points)");
  assert.deepEqual(defaultTrend.map((p) => p.period), ["2026-07", "2026-06"], "default profile must return monthly snapshot periods newest-first");
  assert.deepEqual(defaultTrend.map((p) => p.runId), ["run-snap-2026-07", "run-snap-2026-06"]);
  assert.equal(defaultTrend[0]!.totalEvaluated, 100);
  assert.equal(defaultTrend[0]!.compliant, 90);
});

test("programSites — returns distinct site options only from visible rows", () => {
  const source = `
    import { DIRECTORY } from "./src/config/deployment-profile.ts";
    import { listSites, programSites } from "./src/program/program-read-models.ts";

    const rows = [
      {
        runId: "run-1",
        runStartedAt: "2026-07-17T00:00:00.000Z",
        runScopeType: "MEASURE",
        runStatus: "COMPLETED",
        runTriggeredBy: "manual",
        subjectId: "pat-001",
        measureId: "cms122",
        status: "COMPLIANT",
      },
      {
        runId: "run-1",
        runStartedAt: "2026-07-17T00:00:00.000Z",
        runScopeType: "MEASURE",
        runStatus: "COMPLETED",
        runTriggeredBy: "manual",
        subjectId: "emp-001",
        measureId: "cms122",
        status: "COMPLIANT",
      },
      {
        runId: "run-1",
        runStartedAt: "2026-07-17T00:00:00.000Z",
        runScopeType: "MEASURE",
        runStatus: "COMPLETED",
        runTriggeredBy: "manual",
        subjectId: "cypress-mrn-unresolvable",
        measureId: "cms122",
        status: "COMPLIANT",
      },
    ];

    const fakeDeps = {
      outcomeStore: {
        listLatestPopulationOutcomes: async () => rows,
        listOutcomesWithRun: async () => rows,
      },
      webChartEnv: {},
    };

    const sites = await programSites(fakeDeps);
    console.log(JSON.stringify({ sites, catalogSites: listSites(DIRECTORY.employees) }));
  `;

  const mauiOutput = runProfileChild("maui", source);
  const mauiSites = mauiOutput.sites as string[];
  assert.deepEqual(mauiSites, ["Wailuku Clinic"], "Maui profile must only return sites from visible rows, excluding foreign subjects and un-evaluated catalog sites");

  const defaultOutput = runProfileChild(undefined, source);
  const defaultSites = defaultOutput.sites as string[];
  assert.deepEqual(
    defaultSites,
    ["Clinic", "HQ", "Kihei Clinic", "North Campus", "Outpatient Clinic", "Plant A", "Plant B", "South Campus", "Wailuku Clinic"],
    "default profile must preserve the full pre-change catalog site list",
  );
});
test("programSites — scoped profile selects the latest run from visible rows", () => {
  const source = `
    import { programSites } from "./src/program/program-read-models.ts";

    const olderVisible = {
      runId: "run-old", runStartedAt: "2026-07-17T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "pat-001", measureId: "cms122", status: "COMPLIANT",
    };
    const newerForeign = {
      runId: "run-new", runStartedAt: "2026-07-18T00:00:00.000Z", runScopeType: "MEASURE",
      runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "emp-001", measureId: "cms122", status: "OVERDUE",
    };
    const fakeDeps = {
      outcomeStore: {
        listLatestPopulationOutcomes: async () => [newerForeign],
        listOutcomesWithRun: async () => [olderVisible, newerForeign],
      },
      webChartEnv: {},
    };

    console.log(JSON.stringify({ sites: await programSites(fakeDeps) }));
  `;

  const mauiOutput = runProfileChild("maui", source);
  assert.deepEqual(mauiOutput.sites, ["Wailuku Clinic"], "Maui must retain the older visible run when the newest run is foreign");

  const defaultOutput = runProfileChild(undefined, source);
  assert.deepEqual(
    defaultOutput.sites,
    ["Clinic", "HQ", "Kihei Clinic", "North Campus", "Outpatient Clinic", "Plant A", "Plant B", "South Campus", "Wailuku Clinic"],
    "default profile must keep the full catalog site list",
  );
});
