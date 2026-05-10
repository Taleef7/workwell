"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { emitToast } from "@/lib/toast";
import { useApi } from "@/lib/api/hooks";

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

export default function ProgramDetailPage() {
  const params = useParams<{ measureId: string }>();
  const measureId = params.measureId;
  const api = useApi();

  const [program, setProgram] = useState<ProgramSummary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [drivers, setDrivers] = useState<TopDrivers>({ bySite: [], byRole: [], byOutcomeReason: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!measureId) return;
    async function load() {
      try {
        const programs = await api.get<ProgramSummary[]>("/api/programs");
        setProgram(programs.find((p) => p.measureId === measureId) ?? null);
        try {
          const t = await api.get<TrendPoint[]>(`/api/programs/${measureId}/trend`);
          setTrend(t);
        } catch {
          setTrend([]);
        }
        try {
          const d = await api.get<TopDrivers>(`/api/programs/${measureId}/top-drivers`);
          setDrivers(d);
        } catch {
          setDrivers({ bySite: [], byRole: [], byOutcomeReason: [] });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    }
    void load();
  }, [api, measureId]);

  const prevRate = trend.length > 1 ? trend[1].complianceRate : program?.complianceRate ?? 0;
  const delta = (program?.complianceRate ?? 0) - prevRate;

  return (
    <section className="space-y-4">
      <Link href="/programs" className="text-sm text-slate-500 hover:underline">← Back to Programs</Link>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {program ? (
        <>
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-500">{program.policyRef}</p>
            <h2 className="text-2xl font-semibold text-slate-900">{program.measureName}</h2>
            <p className="text-sm text-slate-600">Version {program.version}</p>
            <div className="mt-3 flex items-end gap-3">
              <p className="text-4xl font-semibold text-slate-900">{program.complianceRate.toFixed(1)}%</p>
              <p className={`text-sm font-medium ${delta >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                {delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(1)} from previous
              </p>
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-white p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Compliance trend (last 10)</p>
            <Sparkline points={trend.map((t) => t.complianceRate)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Top sites</p>
              {drivers.bySite.length === 0 ? <p className="mt-2 text-xs text-slate-500">-</p> : drivers.bySite.map((s) => <p key={s.site} className="mt-1 text-xs">{s.site}: {s.overdueCount}</p>)}
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Top roles</p>
              {drivers.byRole.length === 0 ? <p className="mt-2 text-xs text-slate-500">-</p> : drivers.byRole.map((r) => <p key={r.role} className="mt-1 text-xs">{r.role}: {r.overdueCount}</p>)}
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Reason mix</p>
              {drivers.byOutcomeReason.length === 0 ? <p className="mt-2 text-xs text-slate-500">-</p> : drivers.byOutcomeReason.map((r) => <p key={r.reason} className="mt-1 text-xs">{r.reason}: {r.count} ({r.pct.toFixed(1)}%)</p>)}
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-white p-4">
            <p className="text-sm font-semibold text-slate-900">Measures in this Program</p>
            <table className="mt-2 min-w-full text-xs">
              <thead className="text-left text-slate-600">
                <tr>
                  <th className="py-1">Version</th>
                  <th className="py-1">Compliant</th>
                  <th className="py-1">Due Soon</th>
                  <th className="py-1">Overdue</th>
                  <th className="py-1">Missing</th>
                  <th className="py-1">Excluded</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-200">
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
            <Link href={`/cases?measureId=${encodeURIComponent(program.measureId)}`} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800">
              Open Worklist (Filtered)
            </Link>
            <button
              className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white"
              onClick={() => {
                void (async () => {
                  try {
                    setError(null);
                    await api.post("/api/runs/manual", { scopeType: "MEASURE", measureId });
                    emitToast(`${program.measureName} run completed`);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Unknown error");
                  }
                })();
              }}
            >
              Run This Measure
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-slate-600">Loading program detail...</p>
      )}
    </section>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const width = 360;
  const height = 80;
  if (!points.length) {
    return <div className="h-[80px] rounded border border-dashed border-slate-300 bg-slate-50" />;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = points.length === 1 ? 0 : width / (points.length - 1);
  const d = points.map((p, i) => {
    const x = i * step;
    const y = height - ((p - min) / range) * height;
    return `${i === 0 ? "M" : "L"}${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[80px] w-full rounded border border-slate-200 bg-white">
      <path d={d} fill="none" stroke="#0f172a" strokeWidth="2" />
    </svg>
  );
}
