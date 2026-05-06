"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  const apiBase = useMemo(() => (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, ""), []);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [trendByMeasure, setTrendByMeasure] = useState<Record<string, TrendPoint[]>>({});
  const [driversByMeasure, setDriversByMeasure] = useState<Record<string, TopDrivers>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/programs`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load programs (${response.status})`);
      const data = (await response.json()) as ProgramSummary[];
      setPrograms(data);

      const trendPairs = await Promise.all(
        data.map(async (program) => {
          const r = await fetch(`${apiBase}/api/programs/${program.measureId}/trend`, { cache: "no-store" });
          return [program.measureId, r.ok ? ((await r.json()) as TrendPoint[]) : []] as const;
        })
      );
      setTrendByMeasure(Object.fromEntries(trendPairs));

      const driverPairs = await Promise.all(
        data.map(async (program) => {
          const r = await fetch(`${apiBase}/api/programs/${program.measureId}/top-drivers`, { cache: "no-store" });
          const empty: TopDrivers = { bySite: [], byRole: [], byOutcomeReason: [] };
          return [program.measureId, r.ok ? ((await r.json()) as TopDrivers) : empty] as const;
        })
      );
      setDriversByMeasure(Object.fromEntries(driverPairs));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    if (apiBase) {
      const timer = setTimeout(() => {
        void loadAll();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [apiBase, loadAll]);

  async function runAllMeasuresNow() {
    setError(null);
    try {
      const r = await fetch(`${apiBase}/api/runs/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "All Programs" })
      });
      if (!r.ok) throw new Error(`Manual run failed (${r.status})`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
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

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {loading ? <p className="text-sm text-slate-600">Loading programs...</p> : null}

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
                <Badge label={`COMPLIANT ${program.compliant}`} tone="green" />
                <Badge label={`DUE_SOON ${program.dueSoon}`} tone="amber" />
                <Badge label={`OVERDUE ${program.overdue}`} tone="red" />
                <Badge label={`MISSING_DATA ${program.missingData}`} tone="slate" />
                <Badge label={`EXCLUDED ${program.excluded}`} tone="slate" />
              </div>

              <div className="mt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Trend</p>
                <Sparkline points={trend.map((t) => t.complianceRate)} />
              </div>

              <div className="mt-4 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                <div>
                  <p className="font-semibold text-slate-800">Top Sites</p>
                  {drivers.bySite.length === 0 ? <p>-</p> : drivers.bySite.map((s) => <p key={s.site}>{s.site}: {s.overdueCount}</p>)}
                </div>
                <div>
                  <p className="font-semibold text-slate-800">Top Roles</p>
                  {drivers.byRole.length === 0 ? <p>-</p> : drivers.byRole.map((r) => <p key={r.role}>{r.role}: {r.overdueCount}</p>)}
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

function Badge({ label, tone }: { label: string; tone: "green" | "amber" | "red" | "slate" }) {
  const style = tone === "green"
    ? "bg-emerald-100 text-emerald-700"
    : tone === "amber"
    ? "bg-amber-100 text-amber-800"
    : tone === "red"
    ? "bg-rose-100 text-rose-700"
    : "bg-slate-100 text-slate-700";
  return <span className={`rounded-full px-2 py-1 font-medium ${style}`}>{label}</span>;
}

function Sparkline({ points }: { points: number[] }) {
  const width = 240;
  const height = 60;
  if (!points.length) {
    return <div className="h-[60px] rounded border border-dashed border-slate-300 bg-slate-50" />;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = points.length === 1 ? 0 : width / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = i * step;
      const y = height - ((p - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[60px] w-full rounded border border-slate-200 bg-white">
      <path d={d} fill="none" stroke="#334155" strokeWidth="2" />
    </svg>
  );
}
