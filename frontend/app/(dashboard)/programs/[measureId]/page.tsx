"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  AreaChart, Area, XAxis, YAxis, CartesianGrid
} from "recharts";
import { Button } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { useApi } from "@/lib/api/hooks";
import { fmtCount } from "@/lib/format";
import { useAuth } from "@/components/auth-provider";
import { useRunStatus } from "@/components/run-status-provider";
import { SkeletonCard } from "@/components/skeleton-loader";
import { canRunMeasures } from "@/lib/rbac";
import { OUTCOME_LABELS, ROLE_LABELS, labelFor } from "@/lib/status";
import { niceDomain, chartTooltipStyle } from "@/lib/charts";
import { useTheme } from "@/lib/useTheme";
import { ChartDataTable } from "@/components/chart-data-table";

type ProgramSummary = {
  measureId: string;
  measureName: string;
  policyRef: string;
  version: string;
  latestRunId: string | null;
  latestRunAt: string | null;
  totalEvaluated: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  complianceRate: number;
  openCaseCount: number;
};

type TrendPoint = {
  runId: string;
  startedAt: string;
  complianceRate: number;
  totalEvaluated: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
};

type QualitySnapshot = {
  measureId: string;
  period: string;
  scopeLevel: string;
  scopeId: string;
  tenantId: string | null;
  numerator: number;
  denominator: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
};

type Tenant = { id: string; name: string };

type TopDrivers = {
  bySite: Array<{ site: string; overdueCount: number; note: string }>;
  byRole: Array<{ role: string; overdueCount: number }>;
  byOutcomeReason: Array<{ reason: string; count: number; pct: number }>;
};

type RiskOutlook = {
  upcomingNonCompliantCount: number;
  upcomingExpirations: Array<{
    externalId: string;
    name: string;
    site: string;
    measureName: string;
    lastExamDate: string;
    complianceWindowDays: number;
    daysSinceLastExam: number;
    daysUntilDueSoon: number;
    predictedDueSoonDate: string;
  }>;
  repeatNonCompliers: Array<{
    externalId: string;
    name: string;
    site: string;
    measureName: string;
    streakCount: number;
  }>;
  siteComplianceRates: Array<{
    site: string;
    total: number;
    compliant: number;
    upcomingExpirations: number;
    currentComplianceRate: number;
    predictedComplianceRate: number;
  }>;
};

const OUTCOME_COLORS: Record<string, string> = {
  COMPLIANT: "#059669",
  DUE_SOON: "#d97706",
  OVERDUE: "#e11d48",
  MISSING_DATA: "#7c3aed",
  EXCLUDED: "#64748b"
};

function formatTimestamp(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export default function ProgramDetailPage() {
  const params = useParams<{ measureId: string }>();
  const measureId = params.measureId;
  const api = useApi();
  const { user } = useAuth();
  const mayRun = canRunMeasures(user?.role);
  const { startTracking } = useRunStatus();
  const { theme } = useTheme();

  const [program, setProgram] = useState<ProgramSummary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [drivers, setDrivers] = useState<TopDrivers>({ bySite: [], byRole: [], byOutcomeReason: [] });
  const [riskOutlook, setRiskOutlook] = useState<RiskOutlook | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stale-fetch guard (Fable M20): navigating measure A → B must not let A's slow response paint under
  // B. Only the latest load applies its result.
  const reqIdRef = useRef(0);
  const load = useCallback(async () => {
    if (!measureId) return;
    const reqId = ++reqIdRef.current;
    // The four reads are independent of each other — fire them concurrently instead of
    // as a 4-step waterfall (the previous serial chain was the main "view detail is slow"
    // cause). 90-day risk lookahead (#150 M8): a 30-day horizon is too narrow for annual
    // measures, so the predicted rate just echoed the current rate; a quarter-ahead horizon
    // surfaces real upcoming expirations.
    const [programsRes, trendRes, driversRes, outlookRes] = await Promise.allSettled([
      api.get<ProgramSummary[]>("/api/programs"),
      api.get<TrendPoint[]>(`/api/programs/${measureId}/trend`),
      api.get<TopDrivers>(`/api/programs/${measureId}/top-drivers`),
      api.get<RiskOutlook>(`/api/programs/${measureId}/risk-outlook?horizonDays=90`),
    ]);
    if (reqId !== reqIdRef.current) return;
    if (programsRes.status === "fulfilled") {
      setProgram(programsRes.value.find((p) => p.measureId === measureId) ?? null);
    } else {
      setError(programsRes.reason instanceof Error ? programsRes.reason.message : "Unknown error");
    }
    setTrend(trendRes.status === "fulfilled" ? trendRes.value : []);
    setDrivers(driversRes.status === "fulfilled" ? driversRes.value : { bySite: [], byRole: [], byOutcomeReason: [] });
    setRiskOutlook(outlookRes.status === "fulfilled" ? outlookRes.value : null);
  }, [api, measureId]);

  useEffect(() => {
    // Defer a tick so the loader's setState doesn't run in the effect body (matches /cases, /programs).
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Refresh the trend + drivers when a run triggered from this page (or anywhere) completes — the
  // global RunStatusProvider fires ww:run-complete on the terminal transition.
  useEffect(() => {
    const onComplete = () => void load();
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [load]);

  const prevRate = trend.length > 1 ? trend[1].complianceRate : program?.complianceRate ?? 0;
  const delta = (program?.complianceRate ?? 0) - prevRate;

  const outcomeBreakdown = program
    ? [
        { key: "COMPLIANT", value: program.compliant },
        { key: "DUE_SOON", value: program.dueSoon },
        { key: "OVERDUE", value: program.overdue },
        { key: "MISSING_DATA", value: program.missingData },
        { key: "EXCLUDED", value: program.excluded }
      ].filter((slice) => slice.value > 0)
    : [];

  const runHistory = [...trend].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return (
    <section className="space-y-4">
      <Link href="/programs" className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline">← Back to Programs</Link>
      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {program ? (
        <>
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="text-xs uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">{program.policyRef}</p>
            <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{program.measureName}</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">Version {program.version}</p>
            <div className="mt-3 flex items-end gap-3">
              <p className="text-4xl font-semibold text-neutral-900 dark:text-neutral-100">{program.complianceRate.toFixed(1)}%</p>
              <p className={`text-sm font-medium ${delta >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>
                {delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(1)} from previous
              </p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Compliance trend (last 10 runs)</p>
              <ComplianceTrendChart points={[...trend].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())} />
            </div>
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Outcome breakdown (latest run)</p>
              {outcomeBreakdown.length === 0 ? (
                <div className="flex h-[200px] items-center justify-center rounded border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">No outcomes for the latest run</span>
                </div>
              ) : (
                <>
                  {/* aria-hidden — the sr-only ChartDataTable below is the accessible
                      alternative. Disable Recharts' built-in keyboard layers (default-focusable
                      in v3) so no focusable element lives inside the aria-hidden subtree:
                      accessibilityLayer={false} on PieChart + rootTabIndex={-1} on Pie. */}
                  <div aria-hidden="true">
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart accessibilityLayer={false}>
                        <Pie
                          data={outcomeBreakdown}
                          dataKey="value"
                          nameKey="key"
                          rootTabIndex={-1}
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={75}
                          paddingAngle={2}
                        >
                          {outcomeBreakdown.map((slice) => (
                            <Cell key={slice.key} fill={OUTCOME_COLORS[slice.key] ?? "#94a3b8"} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value, name) => [value, labelFor(OUTCOME_LABELS, String(name))]}
                          {...chartTooltipStyle(theme)}
                        />
                        <Legend
                          formatter={(value) => labelFor(OUTCOME_LABELS, String(value))}
                          wrapperStyle={{ fontSize: 11 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ChartDataTable
                    caption="Outcome breakdown for the latest run"
                    columns={["Outcome", "Subjects"]}
                    rows={outcomeBreakdown.map((slice) => [labelFor(OUTCOME_LABELS, slice.key), slice.value])}
                  />
                </>
              )}
            </div>
          </div>

          <QualityOverTime measureId={measureId} measureName={program.measureName} />

          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Risk outlook (next 90 days)</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950/40">
                <p className="text-xs text-orange-800 dark:text-orange-300">Upcoming due soon</p>
                <p className="text-2xl font-semibold text-orange-900 dark:text-orange-200">
                  {riskOutlook?.upcomingNonCompliantCount ?? 0}
                </p>
              </div>
              <div className="rounded border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950/40">
                <p className="text-xs text-rose-800 dark:text-rose-300">Repeat non-compliers</p>
                <p className="text-2xl font-semibold text-rose-900 dark:text-rose-200">
                  {riskOutlook?.repeatNonCompliers.length ?? 0}
                </p>
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="text-xs text-amber-800 dark:text-amber-300">Highest-risk site</p>
                <p className="text-lg font-semibold text-amber-900 dark:text-amber-200">
                  {riskOutlook?.siteComplianceRates?.[0]?.site ?? "—"}
                </p>
              </div>
            </div>

            {riskOutlook?.repeatNonCompliers && riskOutlook.repeatNonCompliers.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">Repeat non-compliers</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left text-neutral-600 dark:text-neutral-400">
                      <tr>
                        <th scope="col" className="py-1 pr-3">Employee</th>
                        <th scope="col" className="py-1 pr-3">Site</th>
                        <th scope="col" className="py-1 pr-3">Streak</th>
                      </tr>
                    </thead>
                    <tbody>
                      {riskOutlook.repeatNonCompliers.map((item) => (
                        <tr key={`${item.externalId}-${item.streakCount}`} className="border-t border-neutral-200 dark:border-neutral-800">
                          <td className="py-1 pr-3">
                            <Link href={`/employees/${item.externalId}`} className="font-medium text-primary-700 dark:text-primary-400 hover:underline">
                              {item.name}
                            </Link>
                          </td>
                          <td className="py-1 pr-3">{item.site}</td>
                          <td className="py-1 pr-3 text-rose-700 dark:text-rose-400">{item.streakCount}x</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">No repeat non-compliers detected at the moment.</p>
            )}

            {riskOutlook?.siteComplianceRates && riskOutlook.siteComplianceRates.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">Site risk heatmap</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left text-neutral-600 dark:text-neutral-400">
                      <tr>
                        <th scope="col" className="py-1 pr-3">Site</th>
                        <th scope="col" className="py-1 pr-3">Current rate</th>
                        <th scope="col" className="py-1 pr-3">Predicted 90d</th>
                        <th scope="col" className="py-1 pr-3">Expiring</th>
                      </tr>
                    </thead>
                    <tbody>
                      {riskOutlook.siteComplianceRates.map((site) => (
                        <tr key={site.site} className="border-t border-neutral-200 dark:border-neutral-800">
                          <td className="py-1 pr-3">{site.site}</td>
                          <td className="py-1 pr-3">{site.currentComplianceRate.toFixed(1)}%</td>
                          <td className="py-1 pr-3">{site.predictedComplianceRate.toFixed(1)}%</td>
                          <td className="py-1 pr-3">{site.upcomingExpirations}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Top sites</p>
              {drivers.bySite.length === 0 ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">No site concentration in the latest run.</p> : drivers.bySite.map((s) => <p key={s.site} className="mt-1 text-xs">{s.site}: {s.overdueCount}</p>)}
            </div>
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Top roles</p>
              {drivers.byRole.length === 0 ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">No role concentration in the latest run.</p> : drivers.byRole.map((r) => <p key={r.role} className="mt-1 text-xs">{labelFor(ROLE_LABELS, r.role)}: {r.overdueCount}</p>)}
            </div>
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Reason mix</p>
              {drivers.byOutcomeReason.length === 0 ? (
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">No flagged reasons in the latest run.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {drivers.byOutcomeReason.map((r) => (
                    <div key={r.reason}>
                      <div className="flex justify-between text-xs">
                        <span>{labelFor(OUTCOME_LABELS, r.reason)}</span>
                        <span className="text-neutral-500 dark:text-neutral-400">{r.count} ({r.pct.toFixed(1)}%)</span>
                      </div>
                      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, Math.max(0, r.pct))}%`,
                            backgroundColor: OUTCOME_COLORS[r.reason] ?? "#94a3b8"
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Run history</p>
              <Link href="/runs" className="text-xs font-medium text-primary-700 dark:text-primary-400 hover:underline">
                View all runs →
              </Link>
            </div>
            {runHistory.length === 0 ? (
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">No runs recorded for this measure yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-neutral-600 dark:text-neutral-400">
                    <tr>
                      <th scope="col" className="py-1 pr-3">Run</th>
                      <th scope="col" className="py-1 pr-3">Started</th>
                      <th scope="col" className="py-1 pr-3">Compliance</th>
                      <th scope="col" className="py-1 pr-3">Evaluated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runHistory.map((run) => (
                      <tr key={run.runId} className="border-t border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                        <td className="py-1 pr-3">
                          <Link
                            href={`/runs?runId=${encodeURIComponent(run.runId)}`}
                            className="font-medium text-primary-700 dark:text-primary-400 hover:underline"
                            title={run.runId}
                          >
                            {run.runId.slice(0, 8)}...
                          </Link>
                        </td>
                        <td className="py-1 pr-3 text-neutral-600 dark:text-neutral-400">{formatTimestamp(run.startedAt)}</td>
                        <td className="py-1 pr-3">{run.complianceRate.toFixed(1)}%</td>
                        <td className="py-1 pr-3">{run.totalEvaluated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Outcome breakdown by version</p>
            <table className="mt-2 min-w-full text-xs">
              <thead className="text-left text-neutral-600 dark:text-neutral-400">
                <tr>
                  <th scope="col" className="py-1">Version</th>
                  <th scope="col" className="py-1">Compliant</th>
                  <th scope="col" className="py-1">Due Soon</th>
                  <th scope="col" className="py-1">Overdue</th>
                  <th scope="col" className="py-1">Missing</th>
                  <th scope="col" className="py-1">Excluded</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="py-1">{program.version}</td>
                  <td className="py-1">{program.compliant}</td>
                  <td className="py-1">{program.dueSoon}</td>
                  <td className="py-1">{program.overdue}</td>
                  <td className="py-1">{program.missingData}</td>
                  <td className="py-1">{program.excluded}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <Link href={`/cases?measureId=${encodeURIComponent(program.measureId)}`} className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Open Worklist (Filtered)
            </Link>
            {mayRun ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void (async () => {
                    try {
                      setError(null);
                      const res = await api.post<{ scopeType: string; measureId: string }, { runId: string; status?: string }>(
                        "/api/runs/manual",
                        { scopeType: "MEASURE", measureId },
                      );
                      startTracking(res.runId, res.status ?? "REQUESTED");
                      emitToast(`${program.measureName} run started`);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Unknown error");
                    }
                  })();
                }}
              >
                Run This Measure
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="grid gap-3 md:grid-cols-2" role="status" aria-live="polite">
          <span className="sr-only">Loading measure detail…</span>
          {[0, 1].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}
    </section>
  );
}

const rateOf = (s: QualitySnapshot): number =>
  s.denominator > 0 ? Math.round((s.numerator / s.denominator) * 1000) / 10 : 0;

const monthLabel = (period: string): string => {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  // Format in UTC — the period is a calendar month, not a wall-clock instant. Without timeZone:"UTC"
  // a browser west of UTC renders midnight-UTC as the prior local day, showing e.g. "2026-07" as Jun.
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
};

/**
 * E16 PR-3 — "Quality over time (source of truth)". Reads the materialized `quality_snapshots` via
 * GET /api/quality/history: a scope selector (All Systems / per WebChart system), an as-of month
 * picker, and a "compliance on month M" numerator/denominator KPI. Answers Doug's "were they
 * compliant in December? October?" from the persisted aggregate, not a live re-scan. Descriptive
 * only — the numbers are counts of what CQL already decided (ADR-008/ADR-021).
 */
function QualityOverTime({ measureId, measureName }: { measureId: string; measureName: string }) {
  const api = useApi();
  const { theme } = useTheme();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [scope, setScope] = useState<string>("all|ALL"); // "level|id"
  const [snapshots, setSnapshots] = useState<QualitySnapshot[]>([]);
  const [asOf, setAsOf] = useState<string>("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api.get<Tenant[]>("/api/tenants").then(setTenants).catch(() => setTenants([]));
  }, [api]);

  // Stale-fetch guard (Fable M20): changing the scope selector (or navigating measures) must not let an
  // earlier scope's slow response paint under the current one. Only the latest load applies.
  const reqIdRef = useRef(0);
  const load = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    const [level, id] = scope.split("|");
    const qs = new URLSearchParams({ measureId, scopeLevel: level!, scopeId: id! });
    try {
      const rows = await api.get<QualitySnapshot[]>(`/api/quality/history?${qs.toString()}`);
      if (reqId !== reqIdRef.current) return;
      setSnapshots(rows);
      setAsOf((prev) => (prev && rows.some((r) => r.period === prev) ? prev : rows.at(-1)?.period ?? ""));
    } catch {
      if (reqId !== reqIdRef.current) return;
      setSnapshots([]);
    } finally {
      if (reqId === reqIdRef.current) setLoaded(true);
    }
  }, [api, measureId, scope]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // A run triggered from this page materializes a new snapshot for the current month (E16 PR-1),
  // but neither measureId nor scope changes — so re-load on the global ww:run-complete event
  // (the parent page fires the same refresh for its trend/drivers).
  useEffect(() => {
    const onComplete = () => void load();
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [load]);

  const selected = snapshots.find((s) => s.period === asOf) ?? null;
  const data = snapshots.map((s) => ({ label: monthLabel(s.period), rate: rateOf(s) }));
  const [lo, hi] = niceDomain(data.map((d) => d.rate));

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">
          Quality over time <span className="normal-case text-neutral-400">(source of truth)</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-neutral-500 dark:text-neutral-400">
            Scope{" "}
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs"
            >
              <option value="all|ALL">All Systems</option>
              {tenants.map((t) => (
                <option key={t.id} value={`tenant|${t.id}`}>{t.name}</option>
              ))}
            </select>
          </label>
          {snapshots.length > 0 ? (
            <label className="text-xs text-neutral-500 dark:text-neutral-400">
              As of{" "}
              <select
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs"
              >
                {snapshots.map((s) => (
                  <option key={s.period} value={s.period}>{monthLabel(s.period)}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {selected ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="rounded border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
            <p className="text-xs text-emerald-800 dark:text-emerald-300">Compliance on {monthLabel(selected.period)}</p>
            <p className="text-2xl font-semibold text-emerald-900 dark:text-emerald-200">{rateOf(selected).toFixed(1)}%</p>
          </div>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-800/40">
            <p className="text-xs text-neutral-600 dark:text-neutral-400">Numerator / Denominator</p>
            <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{fmtCount(selected.numerator)} / {fmtCount(selected.denominator)}</p>
          </div>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-800/40">
            <p className="text-xs text-neutral-600 dark:text-neutral-400">Excluded (not in denominator)</p>
            <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{selected.excluded}</p>
          </div>
        </div>
      ) : null}

      {snapshots.length > 0 ? (
        <div className="mt-4">
          {/* aria-hidden — sr-only ChartDataTable below is the accessible alternative. */}
          <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={data} accessibilityLayer={false} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="qualityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.2} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <YAxis domain={[lo, hi]} allowDecimals={false} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} width={40} />
                <Tooltip
                  formatter={(value) => [`${Number(value).toFixed(1)}%`, "Compliance"]}
                  {...chartTooltipStyle(theme)}
                />
                <Area type="monotone" dataKey="rate" name="Compliance" stroke="#2563eb" strokeWidth={2.5} fill="url(#qualityGrad)" dot={{ r: 3, fill: "#2563eb", strokeWidth: 0 }} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <ChartDataTable
            caption={`Monthly compliance for ${measureName} (materialized snapshots)`}
            columns={["Month", "Compliance", "Numerator", "Denominator"]}
            rows={snapshots.map((s) => [monthLabel(s.period), `${rateOf(s).toFixed(1)}%`, fmtCount(s.numerator), fmtCount(s.denominator)])}
          />
        </div>
      ) : (
        <div className="mt-3 flex h-[120px] items-center justify-center rounded border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 text-center">
          <span className="max-w-md text-xs text-neutral-500 dark:text-neutral-400">
            {loaded
              ? "No materialized quality snapshots yet for this scope. Snapshots accrue on every population run, or run pnpm seed:quality-history to backfill months of history."
              : "Loading quality history…"}
          </span>
        </div>
      )}
    </div>
  );
}

function ComplianceTrendChart({ points }: { points: TrendPoint[] }) {
  const { theme } = useTheme();
  if (!points.length) {
    return (
      <div className="flex h-[160px] items-center justify-center rounded border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">No run history for this measure yet</span>
      </div>
    );
  }

  // Focus the compliance-rate line (the per-bucket dashed overlays forced a 0–100 domain
  // and read as noise — the pie + reason-mix below already break down the buckets). A
  // dynamic, padded domain makes real week-to-week variation visible.
  const data = points.map((p) => ({
    label: new Date(p.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    rate: Math.round(p.complianceRate * 10) / 10,
  }));
  const [lo, hi] = niceDomain(data.map((d) => d.rate));

  return (
    <>
      {/* aria-hidden — sr-only ChartDataTable below is the accessible alternative;
          accessibilityLayer={false} keeps the focusable <svg> out of the hidden subtree. */}
      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} accessibilityLayer={false} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="complianceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#059669" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#059669" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.2} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <YAxis domain={[lo, hi]} allowDecimals={false} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} width={40} />
            <Tooltip
              formatter={(value) => [`${Number(value).toFixed(1)}%`, "Compliance"]}
              {...chartTooltipStyle(theme)}
            />
            <Area
              type="monotone"
              dataKey="rate"
              name="Compliance"
              stroke="#059669"
              strokeWidth={2.5}
              fill="url(#complianceGrad)"
              dot={{ r: 3, fill: "#059669", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ChartDataTable
        caption="Compliance trend by run (last 10 runs)"
        columns={["Run date", "Compliance"]}
        rows={data.map((d) => [d.label, `${d.rate}%`])}
      />
    </>
  );
}
