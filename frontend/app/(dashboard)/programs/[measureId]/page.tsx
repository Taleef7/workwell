"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { emitToast } from "@/lib/toast";
import { useApi } from "@/lib/api/hooks";
import { OUTCOME_LABELS, ROLE_LABELS, labelFor } from "@/lib/status";

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

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Compliance trend (last 10)</p>
              <Sparkline points={trend.map((t) => t.complianceRate)} />
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Outcome breakdown (latest run)</p>
              {outcomeBreakdown.length === 0 ? (
                <div className="flex h-[200px] items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
                  <span className="text-xs text-slate-400">No outcomes for the latest run</span>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={outcomeBreakdown}
                      dataKey="value"
                      nameKey="key"
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
                      contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e2e8f0" }}
                    />
                    <Legend
                      formatter={(value) => labelFor(OUTCOME_LABELS, String(value))}
                      wrapperStyle={{ fontSize: 11 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Top sites</p>
              {drivers.bySite.length === 0 ? <p className="mt-2 text-xs text-slate-500">-</p> : drivers.bySite.map((s) => <p key={s.site} className="mt-1 text-xs">{s.site}: {s.overdueCount}</p>)}
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Top roles</p>
              {drivers.byRole.length === 0 ? <p className="mt-2 text-xs text-slate-500">-</p> : drivers.byRole.map((r) => <p key={r.role} className="mt-1 text-xs">{labelFor(ROLE_LABELS, r.role)}: {r.overdueCount}</p>)}
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Reason mix</p>
              {drivers.byOutcomeReason.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">-</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {drivers.byOutcomeReason.map((r) => (
                    <div key={r.reason}>
                      <div className="flex justify-between text-xs">
                        <span>{labelFor(OUTCOME_LABELS, r.reason)}</span>
                        <span className="text-slate-500">{r.count} ({r.pct.toFixed(1)}%)</span>
                      </div>
                      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
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

          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">Run history</p>
              <Link href="/runs" className="text-xs font-medium text-blue-700 hover:underline">
                View all runs →
              </Link>
            </div>
            {runHistory.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No runs recorded for this measure yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-slate-600">
                    <tr>
                      <th className="py-1 pr-3">Run</th>
                      <th className="py-1 pr-3">Started</th>
                      <th className="py-1 pr-3">Compliance</th>
                      <th className="py-1 pr-3">Evaluated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runHistory.map((run) => (
                      <tr key={run.runId} className="border-t border-slate-200 hover:bg-slate-50">
                        <td className="py-1 pr-3">
                          <Link
                            href={`/runs?runId=${encodeURIComponent(run.runId)}`}
                            className="font-medium text-blue-700 hover:underline"
                            title={run.runId}
                          >
                            {run.runId.slice(0, 8)}...
                          </Link>
                        </td>
                        <td className="py-1 pr-3 text-slate-600">{formatTimestamp(run.startedAt)}</td>
                        <td className="py-1 pr-3">{run.complianceRate.toFixed(1)}%</td>
                        <td className="py-1 pr-3">{run.totalEvaluated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
