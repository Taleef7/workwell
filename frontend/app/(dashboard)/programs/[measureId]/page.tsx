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
import { ApiError } from "@/lib/api/errors";
import { fmtCount } from "@/lib/format";
import { useAuth } from "@/components/auth-provider";
import { useRunStatus } from "@/components/run-status-provider";
import { SkeletonCard } from "@/components/skeleton-loader";
import { canRunMeasures } from "@/lib/rbac";
import { OUTCOME_LABELS, ROLE_LABELS, labelFor } from "@/lib/status";
import { SUBJECT } from "@/lib/terminology";
import { niceDomain, chartTooltipStyle } from "@/lib/charts";
import { useTheme } from "@/lib/useTheme";
import { ChartDataTable } from "@/components/chart-data-table";
import { useMeasureIdentities } from "@/lib/measure-identity";
import { displayRate, type DisplayRate, type NotationSource, type TrendPoint } from "@/lib/measure-rate";
import {
  applySlice,
  beginLoad,
  freshSlices,
  previousTrendPoint,
  type MeasureSlices,
  type ProgramSummary,
  type RiskOutlook,
  type SliceKey,
  type SliceUpdate,
  type TopDrivers,
} from "./measure-slices";

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
  const isPatientTerm = SUBJECT.singular === "patient";
  const { startTracking } = useRunStatus();
  const { theme } = useTheme();
  const { identities, labelFor: measureLabelFor } = useMeasureIdentities();

  const [slices, setSlices] = useState<MeasureSlices<TrendPoint>>(() => freshSlices<TrendPoint>(measureId));
  const [error, setError] = useState<string | null>(null);

  // Every panel lands on its own, and every landing is tagged with the measure it describes. See
  // `measure-slices.ts` for why the tag travels with the data rather than living in a ref: the page
  // used to gate its FIRST PAINT on all four reads, so `risk-outlook` answering 504 after 60 s on the
  // pilot meant the page rendered nothing for a minute.
  const apply = useCallback((update: SliceUpdate<TrendPoint>) => {
    setSlices((current) => applySlice(current, update));
  }, []);

  // The generation of the newest load. Read at RESOLUTION time by the page-level error handler, which
  // is the one piece of state that cannot live in the reducer.
  const loadIdRef = useRef(0);
  const load = useCallback(async () => {
    if (!measureId) return;
    const loadId = ++loadIdRef.current;
    // Rebase onto `(measureId, loadId)`, so the four `applySlice` calls below are accepted and every
    // response from a superseded load is dropped. A NAVIGATION resets to the skeleton; a
    // `ww:run-complete` refresh of the same measure keeps its values and only moves the generation.
    // Done here rather than in the effect body because a synchronous setState in an effect is
    // `react-hooks/set-state-in-effect`, the same reason the effect below defers this call by a tick.
    setSlices((current) => beginLoad(current, measureId, loadId));
    setError(null);
    // 90-day risk lookahead (#150 M8): a 30-day horizon is too narrow for annual measures, so the
    // predicted rate just echoed the current one; a quarter ahead surfaces real upcoming expirations.
    const tz = typeof Intl !== "undefined" && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions()?.timeZone : undefined;
    const trendQs = tz ? `?tz=${encodeURIComponent(tz)}` : "";
    // The `programs` read keeps the page-level error banner, because without it there is no heading
    // and no KPI — there is no page. The other three degrade to their own panel's `failed` state and
    // are caught here rather than left to become unhandled rejections.
    const programs = api
      .get<ProgramSummary[]>("/api/programs")
      .then((rows) => apply({ measureId, loadId, key: "program", value: rows.find((p) => p.measureId === measureId) ?? null }))
      .catch((err: unknown) => {
        // `error` is the one piece of state the reducer does not hold, so it is guarded here instead:
        // without this check a late rejection for the PREVIOUS measure would raise its banner over
        // the new one, even though the matching slice failure is correctly dropped.
        if (loadIdRef.current === loadId) setError(err instanceof Error ? err.message : "Unknown error");
        apply({ measureId, loadId, key: "program", failed: true });
      });
    const panel = <T,>(key: Exclude<SliceKey, "program">, promise: Promise<T>, onValue: (value: T) => SliceUpdate<TrendPoint>) =>
      promise.then((value) => apply(onValue(value))).catch((err: unknown) => {
        console.warn(`[workwell] ${key} read failed for ${measureId}: ${String((err as Error)?.message ?? err)}`);
        apply({ measureId, loadId, key, failed: true });
      });
    await Promise.all([
      programs,
      panel("trend", api.get<TrendPoint[]>(`/api/programs/${measureId}/trend${trendQs}`), (value) => ({ measureId, loadId, key: "trend", value })),
      panel("drivers", api.get<TopDrivers>(`/api/programs/${measureId}/top-drivers`), (value) => ({ measureId, loadId, key: "drivers", value })),
      panel("outlook", api.get<RiskOutlook>(`/api/programs/${measureId}/risk-outlook?horizonDays=90`), (value) => ({ measureId, loadId, key: "outlook", value })),
    ]);
  }, [api, apply, measureId]);

  useEffect(() => {
    // Defer a tick so the loader's setState doesn't run in the effect body (matches /cases, /programs).
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Refresh when a run triggered from this page (or anywhere) completes — the global
  // RunStatusProvider fires ww:run-complete on the terminal transition. No reset: each panel keeps
  // its current value until its own read lands.
  useEffect(() => {
    const onComplete = () => void load();
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [load]);

  // Read the panels only while they describe the measure the route names. A navigation A → B leaves
  // B's fresh object in state one render later, so until it arrives the page shows its skeleton
  // rather than A's numbers under B's heading.
  const view = slices.measureId === measureId ? slices : freshSlices<TrendPoint>(measureId);
  const { program, trend, drivers, outlook: riskOutlook, status } = view;

  // The program summary carries its own improvementNotation, so an inverse measure reads correctly
  // before (or without) /api/measures. When the identity row is present it wins (both come from the
  // backend's MEASURE_IDENTITY table, so they agree) and it also supplies the MIPS/CMS label.
  const identity: NotationSource | null | undefined = identities[measureId] ?? program;
  const isDecrease = identity?.improvementNotation === "decrease";
  const rate: DisplayRate = program
    ? displayRate(program, identity)
    : { label: "Compliance", value: 0, lowerIsBetter: false, numerator: 0, denominator: 0 };
  // Null until the trend is ready AND has a previous point. The old fallback compared the current
  // rate against the current summary, which renders "↑ 0.0 from previous" for a measure whose history
  // holds one run — a claim about a run that does not exist.
  const prevCounts = previousTrendPoint(view);
  const prevRate = prevCounts ? displayRate(prevCounts, identity) : null;
  const delta = program && prevRate ? rate.value - prevRate.value : null;

  const outcomeBreakdown = program
    ? [
        { key: "COMPLIANT", value: program.compliant },
        { key: "DUE_SOON", value: program.dueSoon },
        { key: "OVERDUE", value: program.overdue },
        { key: "MISSING_DATA", value: program.missingData },
        { key: "OUT_OF_POPULATION", value: program.notInPopulation ?? 0 },
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
            <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{measureLabelFor(measureId, program.measureName)}</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">Version {program.version}</p>
            <div className="mt-3 flex items-end gap-3">
              <div>
                <p className="text-4xl font-semibold text-neutral-900 dark:text-neutral-100">{rate.label} {rate.value.toFixed(1)}%</p>
                {rate.lowerIsBetter ? (
                  <p id="lower-is-better-note" className="text-xs text-neutral-500 dark:text-neutral-400">Lower is better</p>
                ) : null}
              </div>
              {delta !== null ? (
                <p
                  aria-describedby={rate.lowerIsBetter ? "lower-is-better-note" : undefined}
                  className={`text-sm font-medium ${(isDecrease ? delta <= 0 : delta >= 0) ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}
                >
                  {delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(1)} from previous
                  <span className="sr-only"> ({rate.lowerIsBetter ? "lower is better" : "higher is better"})</span>
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">{rate.label} trend (last 10 runs)</p>
              {/* The largest panel, and the one this change nearly broke. `ComplianceTrendChart`
                  answers an empty `points` array with "No run history for this measure yet" — a
                  positive claim about the measure. While the whole page waited on all four reads that
                  was unreachable; now that each panel lands on its own, `/api/programs` (a memoized
                  read) answers before `/trend`, so the chart asserted a measure had no history while
                  its history was still loading, and permanently if the read failed. Found by the
                  project's own reviewer, which the seven mutations and two external lanes all missed. */}
              {status.trend === "loading" ? (
                <div className="flex h-[160px] items-center justify-center rounded border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">Loading trend…</span>
                </div>
              ) : status.trend === "failed" ? (
                <div className="flex h-[160px] items-center justify-center rounded border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">Trend unavailable</span>
                </div>
              ) : (
                <ComplianceTrendChart points={[...trend].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())} identity={identity} />
              )}
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

          {/* keyed: a refusal or series for one measure must never paint under the next one's heading */}
          <QualityOverTime key={measureId} measureId={measureId} measureName={program.measureName} identity={identity} />

          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Risk outlook (next 90 days)</p>
            {status.outlook === "loading" ? (
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">Loading risk outlook…</p>
            ) : status.outlook === "failed" || !riskOutlook ? (
              // A named absence. Before this, a 504 on `risk-outlook` rendered as three zeroes and a
              // dash, which reads as a measure with nothing coming due rather than as a read that
              // never answered.
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">Risk outlook unavailable</p>
            ) : (
              <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950/40">
                <p className="text-xs text-orange-800 dark:text-orange-300">Upcoming due soon</p>
                <p className="text-2xl font-semibold text-orange-900 dark:text-orange-200">
                  {riskOutlook?.upcomingNonCompliantCount ?? 0}
                </p>
              </div>
              {/* The "Repeat non-compliers" tile and its table are GONE (ADR-081): the streak they
                  showed could only be computed by scanning the measure's whole retained history, and
                  under a 400-day retention window an annual measure cannot reach three periods at
                  all. The API key remains and is always empty, so nothing else changes. */}
              <div className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="text-xs text-amber-800 dark:text-amber-300">Highest-risk site</p>
                <p className="text-lg font-semibold text-amber-900 dark:text-amber-200">
                  {riskOutlook?.siteComplianceRates?.[0]?.site ?? "—"}
                </p>
              </div>
            </div>

            {riskOutlook?.siteComplianceRates && riskOutlook.siteComplianceRates.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">Site risk heatmap</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left text-neutral-600 dark:text-neutral-400">
                      <tr>
                        <th scope="col" className="py-1 pr-3">Site</th>
                        {/* The outlook rates are compliant ÷ denominator from the backend. For a decrease
                            measure "compliant" is the in-control bucket, so say that rather than showing a
                            compliance-looking number under a "Poor control" headline. */}
                        <th scope="col" className="py-1 pr-3">{isDecrease ? "In control now" : "Current rate"}</th>
                        <th scope="col" className="py-1 pr-3">{isDecrease ? "In control in 90d" : "Predicted 90d"}</th>
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
              </>
            )}
          </div>

          <div className={`grid gap-4 ${isPatientTerm ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}>
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Top sites</p>
              {/* `loading` is distinguished from `no concentration` on all three driver panels: the
                  empty state used to flash in as soon as `program` landed, asserting there was no
                  concentration before anything had been read. */}
              {status.drivers === "loading" ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Loading…</p>
                : status.drivers === "failed" ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Unavailable</p>
                : drivers.bySite.length === 0 ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">No site concentration in the latest run.</p>
                : drivers.bySite.map((s) => <p key={s.site} className="mt-1 text-xs">{s.site}: {s.overdueCount}</p>)}
            </div>
            {!isPatientTerm ? (
              <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Top roles</p>
                {status.drivers === "loading" ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Loading…</p>
                  : status.drivers === "failed" ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Unavailable</p>
                  : drivers.byRole.length === 0 ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">No role concentration in the latest run.</p>
                  : drivers.byRole.map((r) => <p key={r.role} className="mt-1 text-xs">{labelFor(ROLE_LABELS, r.role)}: {r.overdueCount}</p>)}
              </div>
            ) : null}
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Reason mix</p>
              {status.drivers === "loading" ? (
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Loading…</p>
              ) : status.drivers === "failed" ? (
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Unavailable</p>
              ) : drivers.byOutcomeReason.length === 0 ? (
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
            {status.trend === "loading" ? (
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Loading…</p>
            ) : status.trend === "failed" ? (
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Run history unavailable</p>
            ) : runHistory.length === 0 ? (
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">No runs recorded for this measure yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-neutral-600 dark:text-neutral-400">
                    <tr>
                      <th scope="col" className="py-1 pr-3">Run</th>
                      <th scope="col" className="py-1 pr-3">Started</th>
                      <th scope="col" className="py-1 pr-3">{rate.label}</th>
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
                        <td className="py-1 pr-3">{displayRate(run, identity).value.toFixed(1)}%</td>
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
                  <th scope="col" className="py-1">Not in population</th>
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
                  <td className="py-1">{program.notInPopulation ?? 0}</td>
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
      ) : status.program === "loading" ? (
        <div className="grid gap-3 md:grid-cols-2" role="status" aria-live="polite">
          <span className="sr-only">Loading measure detail…</span>
          {[0, 1].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        /* The skeleton is now gated on the STATUS rather than on `program` being truthy. It used to
           run whenever `program` was null, which includes two cases that are not loading at all: an
           unknown or inactive measureId (`/api/programs` answers, `find` returns undefined) and a
           failed programs read, where the error banner appeared with a skeleton spinning under it
           forever. Both announced "Loading measure detail…" to a screen reader indefinitely. Found by
           an external review lane; the `status` this PR introduces is what makes it a one-line fix. */
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {error ? "This measure could not be loaded." : "No active measure with this id."}
        </p>
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
 * E16 PR-3 — "Quality over time". Reads the materialized `quality_snapshots` via
 * GET /api/quality/history: a scope selector (All Systems / per WebChart system), an as-of month
 * picker, and a "compliance on month M" numerator/denominator KPI. Answers Doug's "were they
 * compliant in December? October?" from the persisted aggregate, not a live re-scan. Descriptive
 * only — the numbers are counts of what CQL already decided (ADR-008/ADR-021).
 */
/** The #642 refusal specifically — not any 409 a future change to the route might add. */
function isBasisRefusal(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  try {
    return (JSON.parse(err.body) as { error?: string }).error === "snapshot_basis_unsafe";
  } catch {
    return false;
  }
}

function QualityOverTime({
  measureId,
  measureName,
  identity,
}: {
  measureId: string;
  measureName: string;
  identity?: NotationSource | null;
}) {
  const api = useApi();
  const { theme } = useTheme();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [scope, setScope] = useState<string>("all|ALL"); // "level|id"
  const [snapshots, setSnapshots] = useState<QualitySnapshot[]>([]);
  const [asOf, setAsOf] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  // #642: the server REFUSES the series (409) for a measure whose snapshots would understate its rate —
  // they count patients outside the measure's population in the denominator. Kept apart from "no
  // snapshots yet": one is an absence, the other is a wrong number the page must not show.
  const [withheld, setWithheld] = useState<string | null>(null);

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
      setWithheld(null);
      setSnapshots(rows);
      setAsOf((prev) => (prev && rows.some((r) => r.period === prev) ? prev : rows.at(-1)?.period ?? ""));
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setSnapshots([]);
      setWithheld(isBasisRefusal(err) ? (err as ApiError).message : null);
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

  const rateLabel = identity?.improvementNotation === "decrease" ? "Poor control" : "Compliance";
  const selected = snapshots.find((s) => s.period === asOf) ?? null;
  // One view per snapshot: the displayed percentage AND the numerator/denominator it was made of, so
  // an inverse measure never pairs "Poor control 15.6%" with the compliant numerator.
  const viewOf = (s: QualitySnapshot) => displayRate({ ...s, complianceRate: rateOf(s) }, identity);
  const selectedView = selected ? viewOf(selected) : null;
  const data = snapshots.map((s) => ({
    label: monthLabel(s.period),
    rate: viewOf(s).value,
  }));
  const [lo, hi] = niceDomain(data.map((d) => d.rate));

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">
          Quality over time <span className="normal-case text-neutral-400">(monthly snapshots)</span>
        </p>
        {withheld ? null : <div className="flex flex-wrap items-center gap-2">
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
        </div>}
      </div>

      {withheld ? (
        <p role="note" className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {withheld}
        </p>
      ) : null}

      {withheld ? null : selected && selectedView ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="rounded border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
            <p className="text-xs text-emerald-800 dark:text-emerald-300">{rateLabel} on {monthLabel(selected.period)}</p>
            <p className="text-2xl font-semibold text-emerald-900 dark:text-emerald-200">
              {selectedView.value.toFixed(1)}%
            </p>
          </div>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-800/40">
            <p className="text-xs text-neutral-600 dark:text-neutral-400">Numerator / Denominator</p>
            <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{fmtCount(selectedView.numerator)} / {fmtCount(selectedView.denominator)}</p>
          </div>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-800/40">
            <p className="text-xs text-neutral-600 dark:text-neutral-400">Excluded (not in denominator)</p>
            <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{selected.excluded}</p>
          </div>
        </div>
      ) : null}

      {withheld ? null : snapshots.length > 0 ? (
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
                  formatter={(value) => [`${Number(value).toFixed(1)}%`, rateLabel]}
                  {...chartTooltipStyle(theme)}
                />
                <Area type="monotone" dataKey="rate" name={rateLabel} stroke="#2563eb" strokeWidth={2.5} fill="url(#qualityGrad)" dot={{ r: 3, fill: "#2563eb", strokeWidth: 0 }} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <ChartDataTable
            caption={`Monthly ${rateLabel.toLowerCase()} for ${measureName} (materialized snapshots)`}
            columns={["Month", rateLabel, "Numerator", "Denominator"]}
            rows={snapshots.map((s) => {
              const v = viewOf(s);
              return [monthLabel(s.period), `${v.value.toFixed(1)}%`, fmtCount(v.numerator), fmtCount(v.denominator)];
            })}
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

function ComplianceTrendChart({ points, identity }: { points: TrendPoint[]; identity?: NotationSource | null }) {
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
  const rateLabel = identity?.improvementNotation === "decrease" ? "Poor control" : "Compliance";
  const data = points.map((p) => ({
    label: new Date(p.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    rate: displayRate(p, identity).value,
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
              formatter={(value) => [`${Number(value).toFixed(1)}%`, rateLabel]}
              {...chartTooltipStyle(theme)}
            />
            <Area
              type="monotone"
              dataKey="rate"
              name={rateLabel}
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
        caption={`${rateLabel} trend by run (last 10 runs)`}
        columns={["Run date", rateLabel]}
        rows={data.map((d) => [d.label, `${d.rate}%`])}
      />
    </>
  );
}
