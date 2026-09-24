"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { fmtCount } from "@/lib/format";
import { useAuth } from "@/components/auth-provider";
import { useRunStatus } from "@/components/run-status-provider";
import { SkeletonCard } from "@/components/skeleton-loader";
import { canRunMeasures } from "@/lib/rbac";
import { canSeeEngineering } from "@/lib/public-demo";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { TenantOption } from "@/features/compliance/types";
import { OUTCOME_LABELS, labelFor } from "@/lib/status";
import { SUBJECT } from "@/lib/terminology";
import { niceDomain, chartTooltipStyle } from "@/lib/charts";
import { useTheme } from "@/lib/useTheme";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer,
} from "recharts";
import { ChartDataTable } from "@/components/chart-data-table";
import { useMeasureIdentities } from "@/lib/measure-identity";
import { displayRate, formatRate, isSmallNumbers, type NotationSource } from "@/lib/measure-rate";
import { chartablePoints, trendMeta, type TrendPoint } from "./trend-meta";
import { yearLineFor } from "./year-line";

type ProgramSummary = {
  measureId: string;
  measureName: string;
  policyRef: string;
  version: string;
  latestRunId: string | null;
  latestRunAt: string | null;
  totalEvaluated: number;
  denominator?: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  /** The workflow rate; null when nobody is counted yet (#637). */
  complianceRate: number | null;
  /** Which way the measure improves; sent by the overview API so the rate never waits on /api/measures. */
  improvementNotation?: "increase" | "decrease";
  openCaseCount: number;
  /** The year the latest run scored and the day it describes (#637); absent from an older server. */
  measurementYear?: number | null;
  asOf?: string | null;
};

/** `?include=trend` attaches the per-measure trend to each summary. */
type DetailedSummary = ProgramSummary & { trend?: TrendPoint[] };

/**
 * The chips a card shows: the patients a panel can act on, plus Excluded. Patients outside the
 * measure's population are not shown at all — they are not the measure's concern — and stay in the
 * exports and the run's reconciliation.
 */
const CARD_CHIPS = [
  ["COMPLIANT", "green", "compliant"],
  ["DUE_SOON", "amber", "dueSoon"],
  ["OVERDUE", "red", "overdue"],
  ["MISSING_DATA", "violet", "missingData"],
  ["EXCLUDED", "slate", "excluded"],
] as const;

export default function ProgramsPage() {
  const api = useApi();
  const { user } = useAuth();
  const mayRun = canRunMeasures(user?.role) && canSeeEngineering(user?.role);
  const { isActive: runActive, startTracking } = useRunStatus();
  const { siteId, from, to } = useGlobalFilters();
  const isPatientTerm = SUBJECT.singular === "patient";
  const { identities, labelFor: measureLabelFor } = useMeasureIdentities();
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [tenant, setTenant] = useState("");
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
  const [trendByMeasure, setTrendByMeasure] = useState<Record<string, TrendPoint[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const reqIdRef = useRef(0);
  const [showRunConfirm, setShowRunConfirm] = useState(false);

  const loadAll = useCallback(async () => {
    // Stale-response guard: the two calls below are not cancellable, and a user switching site or
    // tenant quickly can have a slow response for the OLD scope land after the new one's.
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    // Reset here, not only in the detail phase's finally: a PREVIOUS scope's detail call may have left
    // this true, and its own reset is guarded by `reqId === reqIdRef.current` (Codex review, #548).
    setDetailsLoading(false);
    setTrendByMeasure({});

    const params = new URLSearchParams();
    if (siteId) params.set("site", siteId);
    if (tenant) params.set("tenant", tenant);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const suffix = params.toString() ? `?${params.toString()}` : "";

    // TWO requests: the cheap overview paints the page, then the trends fill in place.
    let data: ProgramSummary[];
    try {
      data = await api.get<ProgramSummary[]>(`/api/programs/overview${suffix}`);
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
      return;
    }
    if (reqId !== reqIdRef.current) return;
    setPrograms(data);
    setLoading(false);

    setDetailsLoading(true);
    try {
      const detailed = await api.get<DetailedSummary[]>(
        `/api/programs/overview${suffix}${suffix ? "&" : "?"}include=trend&granularity=month`,
      );
      if (reqId !== reqIdRef.current) return;
      setTrendByMeasure(Object.fromEntries(detailed.map((p) => [p.measureId, p.trend ?? []])));
    } catch {
      if (reqId !== reqIdRef.current) return;
      // The trends are supporting detail; the page is already usable without them.
      setTrendByMeasure({});
    }
    if (reqId === reqIdRef.current) setDetailsLoading(false);
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

  const totalCompliant = programs.reduce((sum, p) => sum + p.compliant, 0);
  const totalDenominator = programs.reduce(
    (sum, p) => sum + (p.denominator ?? (p.totalEvaluated - p.excluded)),
    0
  );
  // Nobody counted yet is no rate, not 0% (#637).
  const overallComplianceRate =
    totalDenominator === 0 ? null : Math.round((totalCompliant * 1000) / totalDenominator) / 10;
  const openCases = programs.reduce((sum, p) => sum + p.openCaseCount, 0);
  const lastRunTimestamp = programs
    .map((p) => p.latestRunAt)
    .filter((ts): ts is string => Boolean(ts))
    .sort()
    .at(-1);
  // On the very first load show an em-dash instead of computed zeros, which read as "everything broken".
  const initialLoad = loading && programs.length === 0;
  const yearLine = yearLineFor(programs, isPatientTerm);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Programs Overview</h2>
          {yearLine ? <p className="text-sm text-neutral-500 dark:text-neutral-400">{yearLine}</p> : null}
        </div>
        <div className="flex items-center gap-3">
          {canSeeEngineering(user?.role) && (
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
          )}
          {/* The multi-tenant rollup is an engineering view; a single practice has nothing to roll up. */}
          {canSeeEngineering(user?.role) ? (
            <Link
              href="/programs/hierarchy"
              className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-400"
            >
              View hierarchy
            </Link>
          ) : null}
          {mayRun ? (
            runActive ? (
              <span role="status" className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
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

      <div className="grid gap-3 md:grid-cols-3">
        <KpiCard label="Overall compliance" value={initialLoad ? "—" : formatRate(overallComplianceRate)} />
        <KpiCard label="Open cases" value={initialLoad ? "—" : fmtCount(openCases)} />
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
        <div className="grid gap-4 lg:grid-cols-2" role="status" aria-live="polite">
          <span className="sr-only">Loading programs…</span>
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
          // The summary carries its own improvementNotation, so an inverse measure reads correctly
          // before (or without) /api/measures. When the identity row is present it wins.
          const notation = identities[program.measureId] ?? program;
          const programRate = displayRate(program, notation);
          const noteId = `lower-note-${program.measureId}`;
          const countedId = `counted-${program.measureId}`;
          const describedBy = [programRate.lowerIsBetter ? noteId : null, programRate.value === null ? countedId : null].filter(Boolean).join(" ") || undefined;
          const label = measureLabelFor(program.measureId, program.measureName);
          const nothingYet = CARD_CHIPS.every(([, , field]) => program[field] === 0);
          return (
            <div key={program.measureId} className="group relative cursor-pointer rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-primary-400 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-primary-600">
              {/* Stretched link: the whole card opens the measure page; interactive children below
                  carry `relative z-10` so they keep their own click targets. */}
              <Link
                href={`/programs/${program.measureId}`}
                aria-label={`View ${label} detail`}
                className="absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              />
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold text-neutral-900 group-hover:text-primary-700 dark:text-neutral-100 dark:group-hover:text-primary-400">{label}</h3>
                <div className="shrink-0 text-right">
                  <p
                    aria-describedby={describedBy}
                    className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100"
                  >
                    {programRate.value === null ? `${programRate.label} —` : `${programRate.label} ${programRate.value.toFixed(1)}%`}
                  </p>
                  {programRate.lowerIsBetter ? (
                    <p id={noteId} className="text-xs text-neutral-500 dark:text-neutral-400">Lower is better</p>
                  ) : null}
                  {programRate.value === null ? (
                    <p id={countedId} className="text-xs text-neutral-500 dark:text-neutral-400">No {SUBJECT.plural} counted yet</p>
                  ) : program.denominator !== undefined ? (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {fmtCount(programRate.numerator)} / {fmtCount(programRate.denominator)}
                    </p>
                  ) : null}
                </div>
              </div>
              {/* Calendar-year (pilot) deployments only: "so far" and CMS's case minimum mean nothing
                  for a rolling-window occupational measure on a small roster (#637 review). */}
              {isPatientTerm && isSmallNumbers(programRate) ? (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  Based on {fmtCount(programRate.denominator)} {programRate.denominator === 1 ? SUBJECT.singular : SUBJECT.plural} so far
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {nothingYet ? (
                  <Badge label="No results yet" tone="neutral" />
                ) : CARD_CHIPS.map(([bucket, tone, field]) => {
                  const text = `${labelFor(OUTCOME_LABELS, bucket)} ${fmtCount(program[field])}`;
                  return (
                    <Badge
                      key={bucket}
                      label={text}
                      tone={tone}
                      href={chipHref(program.measureId, bucket, { siteId, tenant, from, to })}
                      ariaLabel={`${label}: ${text}`}
                    />
                  );
                })}
              </div>

              <div className="relative z-10 mt-4">
                <TrendChart
                  data={trend}
                  loading={detailsLoading}
                  caption={`${program.measureName} trend (${programRate.label.toLowerCase()})`}
                  identity={notation}
                />
              </div>

              <div className="relative z-10 mt-4">
                <Link href={`/cases?measureId=${encodeURIComponent(program.measureId)}`} className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-400">
                  Open Worklist ({program.openCaseCount})
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={showRunConfirm}
        title="Run all active programs?"
        description={`This evaluates every tracked ${SUBJECT.singular} across all ${programs.length} active measures. It cannot be undone, though results are recomputed on each run.`}
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

function chipHref(
  measureId: string,
  bucket: "COMPLIANT" | "DUE_SOON" | "OVERDUE" | "MISSING_DATA" | "EXCLUDED",
  scope: { siteId: string; tenant: string; from: string; to: string },
): string | undefined {
  // The generated scale tenant has counts but NO roster: `buildRoster` excludes scale runs and
  // subjects entirely, so every chip would land on an empty grid under a badge reading thousands.
  // A plain badge says "this number has no list behind it"; a link that lies does not.
  if (scope.tenant === "mhn") return undefined;
  // EVERY chip drills into the compliance roster, scoped to that measure's column — the destination
  // names each patient, which is what the chip is being asked for: the count already knows the
  // cohort, so clicking it must not hand back a screen the user has to re-filter.
  const params = new URLSearchParams();
  params.set("measureId", measureId);
  params.set("status", bucket);
  // The roster honours site; it has no date filter, so forwarding from/to would imply a scope it
  // cannot apply and the destination would not reproduce the clicked count.
  if (scope.siteId) params.set("site", scope.siteId);
  // The card's counts are tenant-scoped when the System selector is set, so the destination has to
  // be too — otherwise the roster answers across every system and contradicts the clicked number.
  if (scope.tenant) params.set("tenant", scope.tenant);
  return `/compliance?${params.toString()}`;
}

function Badge({ label, tone, href, ariaLabel }: { label: string; tone: "green" | "amber" | "red" | "slate" | "violet" | "neutral"; href?: string; ariaLabel?: string }) {
  const style = tone === "green"
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
    : tone === "amber"
    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
    : tone === "red"
    ? "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
    : tone === "violet"
    ? "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
    // Excluded is indigo, the SAME colour the roster cell uses (lib/status.ts).
    : tone === "slate"
    ? "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/30 dark:text-indigo-200"
    : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  // A linked chip must stack above the card's stretched overlay Link (absolute inset-0 z-0), or the
  // overlay swallows the click; hover/focus styles signal that these chips, unlike static ones, navigate.
  const className = `rounded-full px-2 py-1 font-medium ${style}${href ? " relative z-10 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" : ""}`;
  return href
    ? <Link href={href} aria-label={ariaLabel} className={className}>{label}</Link>
    : <span className={className}>{label}</span>;
}

function TrendChart({
  data,
  loading,
  caption,
  identity,
}: {
  data: TrendPoint[];
  loading?: boolean;
  caption: string;
  identity?: NotationSource | null;
}) {
  const { theme } = useTheme();
  // This year's points with a rate, oldest first (#637) — never a line from last year's final run
  // down to this year's first.
  const sorted = chartablePoints(data, identity);

  if (loading && sorted.length === 0) {
    return <div className="h-[90px] animate-pulse rounded border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/50" />;
  }

  if (sorted.length < 2) {
    return (
      <div className="flex h-[90px] items-center justify-center rounded border border-dashed border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">Trend appears after a few more runs</span>
      </div>
    );
  }

  const isDecrease = identity?.improvementNotation === "decrease";
  const rateLabel = isDecrease ? "Poor control" : "Compliance";
  const meta = trendMeta(sorted, identity);
  const { chartData, delta, deltaLabel, dateHeader } = meta;
  const [domainLo, domainHi] = niceDomain(chartData.map((d) => d.rate));
  const isGood = isDecrease ? delta <= 0 : delta >= 0;

  return (
    <div className="space-y-1 text-primary-600 dark:text-primary-400">
      <div className="flex items-center gap-1">
        <span className={`text-xs font-medium ${isGood ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
          {delta >= 0 ? "↑" : "↓"} {Math.abs(Math.round(delta * 10) / 10)}% {deltaLabel}
          <span className="sr-only"> ({isDecrease ? "lower is better" : "higher is better"})</span>
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
              formatter={(v) => [`${v}%`, rateLabel]}
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
        caption={`${caption} by ${meta.monthly ? "month" : "run"}`}
        columns={[dateHeader, rateLabel]}
        rows={chartData.map((d) => [d.label, `${d.rate}%`])}
      />
    </div>
  );
}
