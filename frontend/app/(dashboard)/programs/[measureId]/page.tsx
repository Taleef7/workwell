"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  AreaChart, Area, XAxis, YAxis, CartesianGrid
} from "recharts";
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
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
};

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

  const [program, setProgram] = useState<ProgramSummary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [drivers, setDrivers] = useState<TopDrivers>({ bySite: [], byRole: [], byOutcomeReason: [] });
  const [riskOutlook, setRiskOutlook] = useState<RiskOutlook | null>(null);
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
        try {
          const outlook = await api.get<RiskOutlook>(`/api/programs/${measureId}/risk-outlook?horizonDays=30`);
          setRiskOutlook(outlook);
        } catch {
          setRiskOutlook(null);
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
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Compliance trend (last 10 runs)</p>
              <ComplianceTrendChart points={[...trend].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())} />
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

          <div className="rounded-md border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Risk outlook (next 30 days)</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded border border-orange-200 bg-orange-50 p-3">
                <p className="text-xs text-orange-800">Upcoming due soon</p>
                <p className="text-2xl font-semibold text-orange-900">
                  {riskOutlook?.upcomingNonCompliantCount ?? 0}
                </p>
              </div>
              <div className="rounded border border-rose-200 bg-rose-50 p-3">
                <p className="text-xs text-rose-800">Repeat non-compliers</p>
                <p className="text-2xl font-semibold text-rose-900">
                  {riskOutlook?.repeatNonCompliers.length ?? 0}
                </p>
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs text-amber-800">Highest-risk site</p>
                <p className="text-lg font-semibold text-amber-900">
                  {riskOutlook?.siteComplianceRates?.[0]?.site ?? "—"}
                </p>
              </div>
            </div>

            {riskOutlook?.repeatNonCompliers && riskOutlook.repeatNonCompliers.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Repeat non-compliers</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left text-slate-600">
                      <tr>
                        <th className="py-1 pr-3">Employee</th>
                        <th className="py-1 pr-3">Site</th>
                        <th className="py-1 pr-3">Streak</th>
                      </tr>
                    </thead>
                    <tbody>
                      {riskOutlook.repeatNonCompliers.map((item) => (
                        <tr key={`${item.externalId}-${item.streakCount}`} className="border-t border-slate-200">
                          <td className="py-1 pr-3">
                            <Link href={`/employees/${item.externalId}`} className="font-medium text-blue-700 hover:underline">
                              {item.name}
                            </Link>
                          </td>
                          <td className="py-1 pr-3">{item.site}</td>
                          <td className="py-1 pr-3 text-rose-700">{item.streakCount}x</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-xs text-slate-500">No repeat non-compliers detected at the moment.</p>
            )}

            {riskOutlook?.siteComplianceRates && riskOutlook.siteComplianceRates.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Site risk heatmap</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left text-slate-600">
                      <tr>
                        <th className="py-1 pr-3">Site</th>
                        <th className="py-1 pr-3">Current rate</th>
                        <th className="py-1 pr-3">Predicted 30d</th>
                        <th className="py-1 pr-3">Expiring</th>
                      </tr>
                    </thead>
                    <tbody>
                      {riskOutlook.siteComplianceRates.map((site) => (
                        <tr key={site.site} className="border-t border-slate-200">
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

function ComplianceTrendChart({ points }: { points: TrendPoint[] }) {
  if (!points.length) {
    return (
      <div className="flex h-[160px] items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
        <span className="text-xs text-slate-400">No run history for this measure yet</span>
      </div>
    );
  }

  const data = points.map((p) => ({
    label: new Date(p.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    rate: p.complianceRate,
    compliant: p.compliant,
    dueSoon: p.dueSoon,
    overdue: p.overdue,
    missingData: p.missingData,
    excluded: p.excluded,
  }));

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
        <defs>
          <linearGradient id="complianceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#059669" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#059669" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(value, name) => {
            if (name === "rate") return [`${Number(value).toFixed(1)}%`, "Compliance rate"];
            return [value, String(name)];
          }}
          contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e2e8f0" }}
          labelStyle={{ fontSize: 11, color: "#475569" }}
        />
        <Area
          type="monotone"
          dataKey="rate"
          stroke="#059669"
          strokeWidth={2}
          fill="url(#complianceGrad)"
          dot={{ r: 3, fill: "#059669", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
