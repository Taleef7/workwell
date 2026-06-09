"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OUTCOME_LABELS, ROLE_LABELS, labelFor } from "@/lib/status";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer,
} from "recharts";
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
  const { siteId, from, to } = useGlobalFilters();
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [trendByMeasure, setTrendByMeasure] = useState<Record<string, TrendPoint[]>>({});
  const [driversByMeasure, setDriversByMeasure] = useState<Record<string, TopDrivers>>({});
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<string>("IDLE");
  const [showRunConfirm, setShowRunConfirm] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (siteId) params.set("site", siteId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const data = await api.get<ProgramSummary[]>(`/api/programs/overview${qs ? `?${qs}` : ""}`);
      setPrograms(data);

      const trendPairs = await Promise.all(
        data.map(async (program) => {
          const trendParams = new URLSearchParams();
          if (siteId) trendParams.set("site", siteId);
          if (from) trendParams.set("from", from);
          if (to) trendParams.set("to", to);
          const tqs = trendParams.toString();
          try {
            const trend = await api.get<TrendPoint[]>(`/api/programs/${program.measureId}/trend${tqs ? `?${tqs}` : ""}`);
            return [program.measureId, trend] as const;
          } catch {
            return [program.measureId, []] as const;
          }
        })
      );
      setTrendByMeasure(Object.fromEntries(trendPairs));

      const driverPairs = await Promise.all(
        data.map(async (program) => {
          const driverParams = new URLSearchParams();
          if (siteId) driverParams.set("site", siteId);
          if (from) driverParams.set("from", from);
          if (to) driverParams.set("to", to);
          const dqs = driverParams.toString();
          const empty: TopDrivers = { bySite: [], byRole: [], byOutcomeReason: [] };
          try {
            const drivers = await api.get<TopDrivers>(`/api/programs/${program.measureId}/top-drivers${dqs ? `?${dqs}` : ""}`);
            return [program.measureId, drivers] as const;
          } catch {
            return [program.measureId, empty] as const;
          }
        })
      );
      setDriversByMeasure(Object.fromEntries(driverPairs));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, siteId, from, to]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadAll();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAll]);

  useEffect(() => {
    if (!activeRunId) return;
    const terminal = ["COMPLETED", "FAILED", "PARTIAL_FAILURE", "CANCELLED"];
    if (terminal.includes(activeRunStatus)) return;

    const interval = setInterval(async () => {
      try {
        const run = await api.get<{ status: string }>(`/api/runs/${activeRunId}`);
        setActiveRunStatus(run.status);
        if (run.status === "COMPLETED" || run.status === "PARTIAL_FAILURE") {
          setActiveRunId(null);
          void loadAll();
          emitToast("Run completed — Programs refreshed");
        } else if (run.status === "FAILED" || run.status === "CANCELLED") {
          setActiveRunId(null);
          setRunError("Run failed. Check the Runs page for details.");
        }
      } catch {
        // ignore transient polling errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [activeRunId, activeRunStatus, api, loadAll]);

  async function runAllMeasuresNow() {
    setRunError(null);
    try {
      const result = await api.post<{ scopeType: string }, { runId: string; status: string }>(
        "/api/runs/manual", { scopeType: "ALL_PROGRAMS" }
      );
      setActiveRunId(result.runId);
      setActiveRunStatus("REQUESTED");
      emitToast("Run started — will refresh when complete");
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Run failed. Please try again.");
    }
  }

  const totalEmployeesTracked = programs.reduce((sum, p) => sum + p.totalEvaluated, 0);
  const totalCompliant = programs.reduce((sum, p) => sum + p.compliant, 0);
  const totalEvaluated = programs.reduce((sum, p) => sum + p.totalEvaluated, 0);
  const overallComplianceRate = totalEvaluated === 0 ? 0 : Math.round((totalCompliant * 1000) / totalEvaluated) / 10;
  const openCases = programs.reduce((sum, p) => sum + p.openCaseCount, 0);
  const lastRunTimestamp = programs
    .map((p) => p.latestRunAt)
    .filter((ts): ts is string => Boolean(ts))
    .sort()
    .at(-1);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Programs Overview</h2>
        <div className="flex items-center gap-3">
          {activeRunId ? (
            <span className="animate-pulse text-sm text-neutral-500 dark:text-neutral-400">
              {activeRunStatus === "REQUESTED" ? "Queued…" : "Running…"} ({activeRunStatus.toLowerCase()})
            </span>
          ) : (
            <Button variant="primary" onClick={() => setShowRunConfirm(true)}>
              Run All Measures Now
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <KpiCard label="Employees tracked" value={String(totalEmployeesTracked)} />
        <KpiCard label="Overall compliance" value={`${overallComplianceRate.toFixed(1)}%`} />
        <KpiCard label="Open cases" value={String(openCases)} />
        <KpiCard label="Last run" value={lastRunTimestamp ? new Date(lastRunTimestamp).toLocaleString() : "-"} />
      </div>

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
            <div key={program.measureId} className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{program.measureName}</h3>
                  <p className="text-xs text-neutral-600 dark:text-neutral-400">{program.policyRef} • {program.version}</p>
                </div>
                <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{program.complianceRate.toFixed(1)}%</p>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge label={`${labelFor(OUTCOME_LABELS, "COMPLIANT")} ${program.compliant}`} tone="green" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "DUE_SOON")} ${program.dueSoon}`} tone="amber" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "OVERDUE")} ${program.overdue}`} tone="red" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "MISSING_DATA")} ${program.missingData}`} tone="violet" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "EXCLUDED")} ${program.excluded}`} tone="slate" />
              </div>

              <div className="mt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Trend</p>
                <TrendChart data={trend} />
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

              {drivers.byOutcomeReason && drivers.byOutcomeReason.length > 0 && (
                <div className="mt-3 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">By Reason</p>
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
                        <span className="text-neutral-500 dark:text-neutral-400">{r.count} cases ({r.pct}%)</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between">
                <Link href={`/cases?measureId=${encodeURIComponent(program.measureId)}`} className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-400">
                  Open Worklist ({program.openCaseCount})
                </Link>
                <Link href={`/programs/${program.measureId}`} className="text-sm font-medium text-neutral-700 hover:underline dark:text-neutral-300">
                  View Program Detail
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={showRunConfirm}
        title="Run all active programs?"
        description="This evaluates every tracked employee across all 4 active measures. It cannot be undone, though results are recomputed on each run."
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

function TrendChart({ data }: { data: TrendPoint[] }) {
  const sorted = [...(data ?? [])]
    .filter((t) => t.totalEvaluated > 0)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

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
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.2} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(v: number) => `${v}%`}
            domain={["auto", 100]}
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip
            formatter={(v) => [`${v}%`, "Compliance"]}
            contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e2e8f0" }}
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
  );
}
