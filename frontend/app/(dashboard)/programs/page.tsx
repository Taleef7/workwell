"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { emitToast } from "@/lib/toast";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { OUTCOME_LABELS, ROLE_LABELS, labelFor } from "@/lib/status";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer,
} from "recharts";

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

  async function runAllMeasuresNow() {
    setRunError(null);
    try {
      await api.post("/api/runs/manual", { scopeType: "ALL_PROGRAMS" });
      emitToast("Run completed — All Programs refreshed");
      await loadAll();
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
        <h2 className="text-2xl font-semibold">Programs Overview</h2>
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" onClick={() => void runAllMeasuresNow()}>
          Run All Measures Now
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <KpiCard label="Employees tracked" value={String(totalEmployeesTracked)} />
        <KpiCard label="Overall compliance" value={`${overallComplianceRate.toFixed(1)}%`} />
        <KpiCard label="Open cases" value={String(openCases)} />
        <KpiCard label="Last run" value={lastRunTimestamp ? new Date(lastRunTimestamp).toLocaleString() : "-"} />
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Failed to load program data: {error}
        </p>
      ) : null}
      {runError ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Run failed: {runError}
        </p>
      ) : null}
      {loading ? <p className="text-sm text-slate-600">Loading programs...</p> : null}
      {!loading && programs.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          No active measures. Create and release a measure to begin.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {programs.map((program) => {
          const trend = trendByMeasure[program.measureId] ?? [];
          const drivers = driversByMeasure[program.measureId] ?? { bySite: [], byRole: [], byOutcomeReason: [] };
          return (
            <div key={program.measureId} className="rounded-md border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{program.measureName}</h3>
                  <p className="text-xs text-slate-600">{program.policyRef} • {program.version}</p>
                </div>
                <p className="text-2xl font-semibold text-slate-900">{program.complianceRate.toFixed(1)}%</p>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge label={`${labelFor(OUTCOME_LABELS, "COMPLIANT")} ${program.compliant}`} tone="green" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "DUE_SOON")} ${program.dueSoon}`} tone="amber" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "OVERDUE")} ${program.overdue}`} tone="red" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "MISSING_DATA")} ${program.missingData}`} tone="violet" />
                <Badge label={`${labelFor(OUTCOME_LABELS, "EXCLUDED")} ${program.excluded}`} tone="slate" />
              </div>

              <div className="mt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Trend</p>
                <TrendChart data={trend} />
              </div>

              <div className="mt-4 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                <div>
                  <p className="font-semibold text-slate-800">Top Sites</p>
                  {drivers.bySite.length === 0 ? <p>-</p> : drivers.bySite.map((s) => <p key={s.site}>{s.site}: {s.overdueCount}</p>)}
                </div>
                <div>
                  <p className="font-semibold text-slate-800">Top Roles</p>
                  {drivers.byRole.length === 0 ? <p>-</p> : drivers.byRole.map((r) => <p key={r.role}>{labelFor(ROLE_LABELS, r.role)}: {r.overdueCount}</p>)}
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <Link href={`/cases?measureId=${encodeURIComponent(program.measureId)}`} className="text-sm font-medium text-blue-700 hover:underline">
                  Open Worklist ({program.openCaseCount})
                </Link>
                <Link href={`/programs/${program.measureId}`} className="text-sm font-medium text-slate-700 hover:underline">
                  View Program Detail
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <p className="text-xs uppercase tracking-[0.15em] text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: "green" | "amber" | "red" | "slate" | "violet" }) {
  const style = tone === "green"
    ? "bg-emerald-100 text-emerald-700"
    : tone === "amber"
    ? "bg-amber-100 text-amber-800"
    : tone === "red"
    ? "bg-rose-100 text-rose-700"
    : tone === "violet"
    ? "bg-violet-100 text-violet-800"
    : "bg-slate-100 text-slate-700";
  return <span className={`rounded-full px-2 py-1 font-medium ${style}`}>{label}</span>;
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  if (!data || data.length < 2) {
    return (
      <div className="flex h-[90px] items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
        <span className="text-xs text-slate-400">Not enough run history for trend</span>
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const chartData = sorted.map((t) => ({
    label: new Date(t.startedAt).toLocaleDateString("en", { month: "short" }),
    rate: Math.round(t.complianceRate * 10) / 10,
  }));

  const last = chartData[chartData.length - 1].rate;
  const prev = chartData[chartData.length - 2].rate;
  const delta = (last - prev).toFixed(1);
  const deltaPositive = parseFloat(delta) >= 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <span className={`text-xs font-medium ${deltaPositive ? "text-emerald-600" : "text-rose-600"}`}>
          {deltaPositive ? "↑" : "↓"} {Math.abs(parseFloat(delta))}% from last run
        </span>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(v: number) => `${v}%`}
            domain={["auto", 100]}
            tick={{ fontSize: 10 }}
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
            stroke="#2563eb"
            strokeWidth={2}
            dot={{ r: 3, fill: "#2563eb" }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
