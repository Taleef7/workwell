"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { fmtCount } from "@/lib/format";
import { useAuth } from "@/components/auth-provider";
import { useRunStatus } from "@/components/run-status-provider";
import { canRunMeasures } from "@/lib/rbac";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { TenantOption } from "@/features/compliance/types";
import { OUTCOME_LABELS, ROLE_LABELS, labelFor } from "@/lib/status";
import { niceDomain, chartTooltipStyle } from "@/lib/charts";
import { useTheme } from "@/lib/useTheme";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer,
} from "recharts";
import { ChartDataTable } from "@/components/chart-data-table";
import { SkeletonCard } from "@/components/skeleton-loader";

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
};

type TopDrivers = {
  bySite: Array<{ site: string; overdueCount: number; note: string }>;
  byRole: Array<{ role: string; overdueCount: number }>;
  byOutcomeReason: Array<{ reason: string; count: number; pct: number }>;
};

export default function ProgramsPage() {
  const api = useApi();
  const { user } = useAuth();
  const mayRun = canRunMeasures(user?.role);
  const { isActive: runActive, startTracking } = useRunStatus();
  const { siteId, from, to } = useGlobalFilters();
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [tenant, setTenant] = useState("");
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
  const [trendByMeasure, setTrendByMeasure] = useState<Record<string, TrendPoint[]>>({});
  const [driversByMeasure, setDriversByMeasure] = useState<Record<string, TopDrivers>>({});
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [showRunConfirm, setShowRunConfirm] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (siteId) params.set("site", siteId);
    if (tenant) params.set("tenant", tenant);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const suffix = params.toString() ? `?${params.toString()}` : "";

    let data: ProgramSummary[];
    try {
      data = await api.get<ProgramSummary[]>(`/api/programs/overview${suffix}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
      return;
    }
    // Render KPIs + measure cards as soon as the overview lands; the per-measure trend
    // and driver detail then streams in below (previously the page blocked on ~23 serial
    // requests — overview, then ALL trends, then ALL drivers — before showing anything).
    setPrograms(data);
    setLoading(false);

    setDetailsLoading(true);
    const loadTrends = Promise.all(
      data.map(async (program) => {
        try {
          const trend = await api.get<TrendPoint[]>(`/api/programs/${program.measureId}/trend${suffix}`);
          return [program.measureId, trend] as const;
        } catch {
          return [program.measureId, [] as TrendPoint[]] as const;
        }
      }),
    ).then((pairs) => setTrendByMeasure(Object.fromEntries(pairs)));

    const emptyDrivers: TopDrivers = { bySite: [], byRole: [], byOutcomeReason: [] };
    const loadDrivers = Promise.all(
      data.map(async (program) => {
        try {
          const drivers = await api.get<TopDrivers>(`/api/programs/${program.measureId}/top-drivers${suffix}`);
          return [program.measureId, drivers] as const;
        } catch {
          return [program.measureId, emptyDrivers] as const;
        }
      }),
    ).then((pairs) => setDriversByMeasure(Object.fromEntries(pairs)));

    // Trend and driver fleets are independent — load them concurrently, not in series.
    await Promise.allSettled([loadTrends, loadDrivers]);
    setDetailsLoading(false);
  }, [api, siteId, tenant, from, to]);

  // Tenants/systems for the optional System filter (E13 PR-1). Best-effort; never blocks the overview.
  useEffect(() => {
    let cancelled = false;
    api
      .get<TenantOption[]>("/api/tenants")
      .then((data) => { if (!cancelled) setTenantOptions(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setTenantOptions([]); });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadAll();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAll]);

  // The global RunStatusProvider polls the active run; when it finishes it fires ww:run-complete and
  // we reload the overview. (This survives navigation/reload — the run state lives in the provider.)
  useEffect(() => {
    const onComplete = () => void loadAll();
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [loadAll]);

  async function runAllMeasuresNow() {
    setRunError(null);
    try {
      const result = await api.post<{ scopeType: string }, { runId: string; status: string }>(
        "/api/runs/manual", { scopeType: "ALL_PROGRAMS" }
      );
      startTracking(result.runId, result.status ?? "REQUESTED");
      emitToast("Run started — will refresh when complete");
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Run failed. Please try again.");
    }
  }

  const totalEvaluations = programs.reduce((sum, p) => sum + p.totalEvaluated, 0);
  const totalCompliant = programs.reduce((sum, p) => sum + p.compliant, 0);
  const totalEvaluated = programs.reduce((sum, p) => sum + p.totalEvaluated, 0);
  const overallComplianceRate = totalEvaluated === 0 ? 0 : Math.round((totalCompliant * 1000) / totalEvaluated) / 10;
  const openCases = programs.reduce((sum, p) => sum + p.openCaseCount, 0);
  const lastRunTimestamp = programs
    .map((p) => p.latestRunAt)
    .filter((ts): ts is string => Boolean(ts))
    .sort()
    .at(-1);
  // On the very first load (no data yet) show an em-dash instead of the computed zeros, which would
  // otherwise flash "0.0% compliance / 0 open cases" — reading as "everything broken" for a beat.
  const initialLoad = loading && programs.length === 0;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Programs Overview</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">
            System
            <select
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              aria-label="System"
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm normal-case tracking-normal text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            >
              <option value="">All systems</option>
              {tenantOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <Link
            href="/programs/hierarchy"
            className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-400"
          >
            View hierarchy
          </Link>
          {mayRun ? (
            runActive ? (
              <span className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                Run in progress…
              </span>
            ) : (
              <Button variant="primary" onClick={() => setShowRunConfirm(true)}>
                Run All Measures Now
              </Button>
            )
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <KpiCard label="Evaluations (latest runs)" value={initialLoad ? "—" : String(totalEvaluations)} />
        <KpiCard label="Overall compliance" value={initialLoad ? "—" : `${overallComplianceRate.toFixed(1)}%`} />
        <KpiCard label="Open cases" value={initialLoad ? "—" : String(openCases)} />
        <KpiCard label="Last run" value={initialLoad ? "—" : lastRunTimestamp ? new Date(lastRunTimestamp).toLocaleString() : "-"} />
      </div>

      {tenant === "mhn" ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          MetroHealth Network is a generated population-scale dataset (~120k subjects) that demonstrates rollup
          performance at scale — it has no individual cases or worklist.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          Failed to load program data: {error}
        </p>
      ) : null}
      {runError ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Run failed: {runError}
        </p>
      ) : null}
      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : null}
      {!loading && programs.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
          No active measures. Create and release a measure to begin.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {programs.map((program) => {
          const trend = trendByMeasure[program.measureId] ?? [];
          const drivers = driversByMeasure[program.measureId] ?? { bySite: [], byRole: [], byOutcomeReason: [] };
          return (
            <div key={program.measureId} className="group relative rounded-md border border-neutral-200 bg-white p-4 transition hover:border-primary-400 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-primary-600">
              {/* Stretched link makes the whole card open the measure detail; interactive
                  children below carry `relative z-10` so they keep their own click targets. */}
              <Link
                href={`/programs/${program.measureId}`}
                aria-label={`View ${program.measureName} detail`}
                className="absolute inset-0 z-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              />
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{program.measureName}</h3>
                  <p className="text-xs text-neutral-600 dark:text-neutral-400">{program.policyRef} • {program.version}</p>
                </div>
                <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{program.complianceRate.toFixed(1)}%</p>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge label={`${labelFor(OUTCOME_LABELS, "COMPLIANT")} ${fmtCount(program.compliant)}`} tone="green" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "DUE_SOON")} ${fmtCount(program.dueSoon)}`} tone="amber" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "OVERDUE")} ${fmtCount(program.overdue)}`} tone="red" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "MISSING_DATA")} ${fmtCount(program.missingData)}`} tone="violet" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "EXCLUDED")} ${fmtCount(program.excluded)}`} tone="slate" />
              </div>

              <div className="relative z-10 mt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Trend</p>
                <TrendChart data={trend} loading={detailsLoading} caption={`${program.measureName} compliance trend by run`} />
              </div>

              <div className="mt-4 grid gap-2 text-xs text-neutral-700 sm:grid-cols-2 dark:text-neutral-300">
                <div>
                  <p className="font-semibold text-neutral-800 dark:text-neutral-200">Top Sites</p>
                  {drivers.bySite.length === 0 ? (
                    <p className="text-neutral-400">—</p>
                  ) : (
                    drivers.bySite.map((s) => (
                      <p key={s.site} className="flex justify-between">
                        <span>{s.site}</span>
                        <span className="text-neutral-500 dark:text-neutral-400">{s.overdueCount} overdue</span>
                      </p>
                    ))
                  )}
                </div>
                <div>
                  <p className="font-semibold text-neutral-800 dark:text-neutral-200">Top Roles</p>
                  {drivers.byRole.length === 0 ? (
                    <p className="text-neutral-400">—</p>
                  ) : (
                    drivers.byRole.map((r) => (
                      <p key={r.role} className="flex justify-between">
                        <span>{labelFor(ROLE_LABELS, r.role)}</span>
                        <span className="text-neutral-500 dark:text-neutral-400">{r.overdueCount} overdue</span>
                      </p>
                    ))
                  )}
                </div>
              </div>

              {/* Always render this block so card heights stay stable while driver detail
                  streams in (previously the section vanished when empty, leaving a gap that
                  filled in only after the next run — confusing). */}
              <div className="mt-3 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">By Reason</p>
                {detailsLoading && drivers.byOutcomeReason.length === 0 ? (
                  <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
                ) : drivers.byOutcomeReason.length > 0 ? (
                  <div className="space-y-1">
                    {drivers.byOutcomeReason.map((r) => (
                      <div key={r.reason} className="flex items-center justify-between text-xs">
                        <span className={`rounded px-1.5 py-0.5 font-medium ${
                          r.reason === "OVERDUE"
                            ? "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                            : r.reason === "DUE_SOON"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                            : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                        }`}>
                          {labelFor(OUTCOME_LABELS, r.reason)}
                        </span>
                        <span className="text-neutral-500 dark:text-neutral-400">{fmtCount(r.count)} cases ({r.pct}%)</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-neutral-400">No non-compliance reasons for the latest run.</p>
                )}
              </div>

              <div className="relative z-10 mt-4 flex items-center justify-between">
                <Link href={`/cases?measureId=${encodeURIComponent(program.measureId)}`} className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-400">
                  Open Worklist ({program.openCaseCount})
                </Link>
                <Link href={`/programs/${program.measureId}`} className="text-sm font-medium text-neutral-700 hover:underline dark:text-neutral-300">
                  View detail →
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={showRunConfirm}
        title="Run all active programs?"
        description={`This evaluates every tracked employee across all ${programs.length} active measures. It cannot be undone, though results are recomputed on each run.`}
        confirmLabel="Run all measures"
        cancelLabel="Cancel"
        onCancel={() => setShowRunConfirm(false)}
        onConfirm={() => {
          setShowRunConfirm(false);
          void runAllMeasuresNow();
        }}
      />
    </section>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">{value}</p>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: "green" | "amber" | "red" | "slate" | "violet" }) {
  const style = tone === "green"
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
    : tone === "amber"
    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
    : tone === "red"
    ? "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
    : tone === "violet"
    ? "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
    : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return <span className={`rounded-full px-2 py-1 font-medium ${style}`}>{label}</span>;
}

function TrendChart({ data, loading, caption }: { data: TrendPoint[]; loading?: boolean; caption: string }) {
  const { theme } = useTheme();
  const sorted = [...(data ?? [])]
    .filter((t) => t.totalEvaluated > 0)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  if (loading && sorted.length === 0) {
    return <div className="h-[90px] animate-pulse rounded border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/50" />;
  }

  if (sorted.length < 2) {
    return (
      <div className="flex h-[90px] items-center justify-center rounded border border-dashed border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
        <span className="text-xs text-neutral-400">Not enough run history for trend</span>
      </div>
    );
  }

  const chartData = sorted.map((t) => ({
    label: new Date(t.startedAt).toLocaleDateString("en", { month: "short", day: "numeric" }),
    rate: Math.round(t.complianceRate * 10) / 10,
  }));
  const [domainLo, domainHi] = niceDomain(chartData.map((d) => d.rate));

  const last = chartData[chartData.length - 1].rate;
  const prev = chartData[chartData.length - 2].rate;
  const delta = (last - prev).toFixed(1);
  const deltaPositive = parseFloat(delta) >= 0;

  return (
    <div className="space-y-1 text-primary-600 dark:text-primary-400">
      <div className="flex items-center gap-1">
        <span className={`text-xs font-medium ${deltaPositive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
          {deltaPositive ? "↑" : "↓"} {Math.abs(parseFloat(delta))}% from last run
        </span>
      </div>
      {/* The sr-only ChartDataTable below is the accessible alternative, so the chart is
          aria-hidden. Disable Recharts' built-in accessibilityLayer (default true in v3 —
          it puts tabIndex=0/role="application" on the <svg>), else a keyboard user would tab
          onto a focusable element inside an aria-hidden subtree (axe aria-hidden-focus). */}
      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={80}>
          <LineChart data={chartData} accessibilityLayer={false} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.2} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <YAxis
              tickFormatter={(v: number) => `${v}%`}
              domain={[domainLo, domainHi]}
              allowDecimals={false}
              tick={{ fontSize: 10, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
              width={36}
            />
            <Tooltip
              formatter={(v) => [`${v}%`, "Compliance"]}
              {...chartTooltipStyle(theme)}
            />
            <Line
              type="monotone"
              dataKey="rate"
              stroke="currentColor"
              strokeWidth={2}
              dot={{ r: 3, fill: "currentColor" }}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ChartDataTable
        caption={caption}
        columns={["Run date", "Compliance"]}
        rows={chartData.map((d) => [d.label, `${d.rate}%`])}
      />
    </div>
  );
}
