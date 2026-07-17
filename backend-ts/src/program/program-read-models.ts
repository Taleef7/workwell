/**
 * Programs read models (#107 programs module) — the `/programs` dashboard's overview +
 * site list, ported from ProgramService.listPrograms / listSites.
 *
 * Overview, per Active measure: the LATEST run (filtered by employee site + run period)
 * that produced outcomes for that measure, its outcome-bucket counts, complianceRate
 * (compliant/total × 100, 1 decimal), and the OPEN case count (same site/period filter on
 * the case). Active measures are the catalog's Active set = the engine's runnable set.
 * Employee site is resolved from the synthetic directory (outcomes carry only subjectId).
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, OutcomeWithRun, MeasureOutcomeRow } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { QualitySnapshotStore, QualitySnapshotRow, QualityScopeLevel } from "../stores/quality-snapshot-store.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { ACTIVE_CASE_STATUSES } from "../case/case-logic.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { day, isCompletedRun, isPopulationRun, round1 } from "./rollup-shared.ts";
import { directoryForRows, type DirectorySnapshot } from "../engine/ingress/webchart/live-directory.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";

export interface ProgramSummary {
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
}

export interface ProgramFilters {
  site?: string | null;
  from?: string | null; // inclusive lower bound (day-granular) on run started / case created
  to?: string | null; // inclusive upper bound
  tenant?: string | null; // scope the population to one tenant/system (E13 PR-1)
}

/**
 * Map the page's tenant/site filters to a `quality_snapshots` scope (UX-8). Mirrors how
 * `buildSnapshotRows` keys scope_id: `"ALL"` | tenantId | `${tenantId}|${site}`. A site is
 * resolved to its tenant from the directory when no tenant filter narrows it; an unknown or
 * multi-tenant site returns null → the caller falls back to the per-run trend.
 */
export function snapshotScopeFor(
  filters: ProgramFilters,
  employees: readonly EmployeeProfile[] = EMPLOYEES,
): { scopeLevel: QualityScopeLevel; scopeId: string } | null {
  const site = filters.site?.trim() || null;
  const tenant = filters.tenant?.trim() || null;
  if (site) {
    let tenantId = tenant;
    if (!tenantId) {
      const tenants = [...new Set(employees.filter((e) => e.site === site).map((e) => e.tenantId))];
      if (tenants.length !== 1) return null; // 0 (unknown) or >1 (ambiguous) → per-run fallback
      tenantId = tenants[0]!;
    }
    return { scopeLevel: "site", scopeId: `${tenantId}|${site}` };
  }
  if (tenant) return { scopeLevel: "tenant", scopeId: tenant };
  return { scopeLevel: "all", scopeId: "ALL" };
}

/**
 * Map monthly snapshot rows → trend points for the newest 12 months (UX-8). Returned NEWEST-FIRST
 * to match the per-run branch's contract (the measure page reads `trend[1]` as the previous point).
 * `complianceRate`/`totalEvaluated` use total-INCLUDING-excluded (the sum of all five buckets) so the
 * monthly series reconciles with the per-run branch and the `/programs` headline KPI — not the E16
 * proportion denominator (`total − excluded`).
 */
export function monthlyTrendPoints(rows: QualitySnapshotRow[]): ProgramTrendPoint[] {
  return rows
    .slice()
    .sort((a, b) => b.period.localeCompare(a.period)) // newest-first, matching the per-run path's contract
    .slice(0, 12)
    .map((r): ProgramTrendPoint => {
      const total = r.compliant + r.dueSoon + r.overdue + r.missingData + r.excluded;
      return {
        runId: r.sourceRunId ?? r.id,
        startedAt: r.periodEnd,
        period: r.period,
        complianceRate: round1(r.compliant, total),
        totalEvaluated: total,
        compliant: r.compliant,
        dueSoon: r.dueSoon,
        overdue: r.overdue,
        missingData: r.missingData,
        excluded: r.excluded,
      };
    });
}

export interface ProgramDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  caseStore: CaseStore;
  employees?: readonly EmployeeProfile[];
  /** Optional — the monthly (quality_snapshots) trend source (UX-8). Absent ⇒ per-run trend only. */
  qualitySnapshots?: QualitySnapshotStore;
  /** Runtime environment consumed only through the existing isWebChartConfigured predicate. */
  webChartEnv?: DataSourceEnv;
}

/** Per-run trend point (Java ProgramTrendPoint). The chart reads runId/startedAt/complianceRate/totalEvaluated. */
export interface ProgramTrendPoint {
  runId: string;
  startedAt: string;
  /** Present only for monthly (quality_snapshots) points — `YYYY-MM` (UX-8). Absent ⇒ per-run point. */
  period?: string;
  complianceRate: number;
  totalEvaluated: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
}

export interface TopDrivers {
  bySite: Array<{ site: string; overdueCount: number; note: string }>;
  byRole: Array<{ role: string; overdueCount: number }>;
  byOutcomeReason: Array<{ reason: string; count: number; pct: number }>;
}

export interface RiskOutlook {
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
  repeatNonCompliers: Array<{ externalId: string; name: string; site: string; measureName: string; streakCount: number }>;
  siteComplianceRates: Array<{
    site: string;
    total: number;
    compliant: number;
    upcomingExpirations: number;
    currentComplianceRate: number;
    predictedComplianceRate: number;
  }>;
}

const eq = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/** Distinct employee sites, ascending — the global site filter's options. */
export function listSites(employees: readonly EmployeeProfile[] = EMPLOYEES): string[] {
  return [...new Set(employees.map((e) => e.site).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b));
}

/** Distinct sites from one restart-safe snapshot of the latest successful population rows. */
export async function programSites(deps: Pick<ProgramDeps, "outcomeStore" | "webChartEnv">): Promise<string[]> {
  const rows = (await deps.outcomeStore.listLatestPopulationOutcomes({ excludeScale: true, excludeTrendHistory: true })).filter(
    (row) => isPopulationRun(row.runScopeType) && isCompletedRun(row.runStatus) && row.runTriggeredBy !== "seed:scale",
  );
  return listSites(directoryForRows(rows, isWebChartConfigured(deps.webChartEnv ?? {})).employees);
}

/** One run's site-filtered outcome rows (the unit overview/trend/top-drivers aggregate). */
interface RunGroup {
  runId: string;
  runStartedAt: string;
  rows: OutcomeWithRun[];
}

/** Group site-filtered outcome rows by run (only runs with ≥1 matching row). */
function groupByRun(rows: OutcomeWithRun[]): RunGroup[] {
  const byRun = new Map<string, RunGroup>();
  for (const r of rows) {
    let g = byRun.get(r.runId);
    if (!g) byRun.set(r.runId, (g = { runId: r.runId, runStartedAt: r.runStartedAt, rows: [] }));
    g.rows.push(r);
  }
  return [...byRun.values()];
}

const siteMatcher = (filters: ProgramFilters, employeeLookup = employeeById) => {
  const site = filters.site?.trim() || null;
  return (subjectId: string) => !site || eq(employeeLookup(subjectId)?.site ?? null, site);
};

/** Tenant/system filter (E13 PR-1) — exact tenantId match, resolved read-time from the directory. */
const tenantMatcher = (filters: ProgramFilters, employeeLookup = employeeById) => {
  const tenant = filters.tenant?.trim() || null;
  return (subjectId: string) => !tenant || (employeeLookup(subjectId)?.tenantId ?? null) === tenant;
};

/** Hide only live-tenant ids when the existing runtime seam is off; all non-wc legacy behavior stays unchanged. */
const subjectVisible = (subjectId: string, webChartConfigured: boolean): boolean =>
  webChartConfigured || !subjectId.startsWith("wc|");

export async function programOverview(deps: ProgramDeps, filters: ProgramFilters): Promise<ProgramSummary[]> {
  const from = filters.from?.trim() || null;
  const to = filters.to?.trim() || null;
  const inPeriod = (iso: string): boolean => (!from || day(iso) >= day(from)) && (!to || day(iso) <= day(to));

  // ONE bounded query (measure/date filtering pushed into SQL) instead of fanning out a
  // listOutcomes per run across all history. Site filtering stays in the app (directory).
  // Only terminal (COMPLETED/PARTIAL_FAILURE) population runs are eligible as a measure's "latest
  // run". An in-flight ALL_PROGRAMS run writes outcomes incrementally, so without this filter the
  // newest-by-startedAt group is the RUNNING run with PARTIAL counts — the headline Evaluations
  // number visibly bounced (e.g. 1100 → 200 → 1100) until the run finished.
  // excludeScale drops the scale tenant's ~120k rows IN SQL (the scale KPIs are folded in separately
  // via aggregateScaleRun below). The JS guard stays as defense-in-depth.
  // excludeTrendHistory (Fable M16): the synthetic trend rows are always older than each measure's
  // latest real run, so this overview (latest-run-per-measure) never selects them — dropping them in
  // SQL avoids the fetch-then-discard. The /programs TREND read model below intentionally keeps them.
  const persistedRows = await deps.outcomeStore.listOutcomesWithRun({ from: from ?? undefined, to: to ?? undefined, excludeScale: true, excludeTrendHistory: true });
  const successfulRows = persistedRows.filter(
    (row) => isPopulationRun(row.runScopeType) && isCompletedRun(row.runStatus) && row.runTriggeredBy !== "seed:scale",
  );
  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  const directory = directoryForRows(successfulRows, webChartConfigured);
  const siteMatch = siteMatcher(filters, directory.employeeById);
  const tenantMatch = tenantMatcher(filters, directory.employeeById);
  const rows = successfulRows.filter(
    (row) => subjectVisible(row.subjectId, webChartConfigured) && siteMatch(row.subjectId) && tenantMatch(row.subjectId),
  );
  const byMeasure = new Map<string, OutcomeWithRun[]>();
  for (const r of rows) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
  const cases = await deps.caseStore.listCases({ limit: 100000 });

  const active = MEASURE_CATALOG.filter((m) => m.status === "Active");
  const summaries = active.map((m): ProgramSummary => {
    const groups = groupByRun(byMeasure.get(m.id) ?? []);
    const best = groups.length ? groups.reduce((a, b) => (b.runStartedAt > a.runStartedAt ? b : a)) : null;
    const os = best?.rows ?? [];
    const n = (status: string) => os.filter((o) => o.status === status).length;
    const total = os.length;
    const compliant = n("COMPLIANT");
    const openCaseCount = cases.filter(
      (c) =>
        c.measureId === m.id &&
        (ACTIVE_CASE_STATUSES as readonly string[]).includes(c.status) &&
        subjectVisible(c.employeeId, webChartConfigured) &&
        siteMatch(c.employeeId) &&
        tenantMatch(c.employeeId) &&
        inPeriod(c.createdAt),
    ).length;
    return {
      measureId: m.id,
      measureName: m.name,
      policyRef: m.policyRef,
      version: m.version,
      latestRunId: best?.runId ?? null,
      latestRunAt: best?.runStartedAt ?? null,
      totalEvaluated: total,
      compliant,
      dueSoon: n("DUE_SOON"),
      overdue: n("OVERDUE"),
      missingData: n("MISSING_DATA"),
      excluded: n("EXCLUDED"),
      complianceRate: round1(compliant, total),
      openCaseCount,
    };
  });

  // E13 PR-2: fold in the population-scale mhn tenant's per-measure counts via SQL aggregation
  // (the in-memory scan above excluded seed:scale runs). When ?tenant=mhn, REPLACE the live counts
  // with the scale ones; otherwise ADD them. Skipped when scoped to a non-mhn tenant.
  await foldScaleCounts(deps, summaries, filters);

  return summaries.sort((a, b) => a.measureName.localeCompare(b.measureName));
}

/** Add (or, for ?tenant=mhn, replace with) the scale tenant's per-measure counts from the latest
 *  seed:scale run per measure. Bounded — aggregateScaleRun never materializes the per-subject rows.
 *  Skipped when a site filter is active (scale data has no equivalent site dimension) or when the
 *  date window excludes the scale run's startedAt (keeps filtered KPIs consistent). */
async function foldScaleCounts(deps: ProgramDeps, summaries: ProgramSummary[], filters: ProgramFilters): Promise<void> {
  const tenant = filters.tenant?.trim() || null;
  if (tenant && tenant !== "mhn") return; // scoped to a non-scale tenant → no scale data
  // Scale data is not filterable by the live-tenant site dimension — skip when site is active so
  // a scoped view like ?site=Plant+A doesn't silently add the full 120k mhn population.
  if (filters.site?.trim()) return;
  const from = filters.from?.trim() || null;
  const to = filters.to?.trim() || null;
  const scaleRuns = (await deps.runStore.listRuns(100_000))
    .filter((r) => r.triggeredBy === "seed:scale" && r.status === "COMPLETED")
    // Honor the date window so a date-filtered view doesn't include out-of-window scale runs.
    .filter((r) => (!from || day(r.startedAt) >= from) && (!to || day(r.startedAt) <= to))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (scaleRuns.length === 0) return;
  const latest = new Map<string, string>(); // measureId → latest scale runId
  for (const r of scaleRuns) if (r.scopeId) latest.set(r.scopeId, r.id);

  for (const s of summaries) {
    const runId = latest.get(s.measureId);
    if (!runId) {
      if (tenant === "mhn") zeroSummary(s); // mhn-scoped but no scale data for this measure
      continue;
    }
    const groups = await deps.outcomeStore.aggregateScaleRun(runId);
    const n = (st: string) => groups.filter((g) => g.status === st).reduce((a, g) => a + g.count, 0);
    const baseTotal = tenant === "mhn" ? 0 : s.totalEvaluated;
    const base = (cur: number) => (tenant === "mhn" ? 0 : cur);
    s.compliant = base(s.compliant) + n("COMPLIANT");
    s.dueSoon = base(s.dueSoon) + n("DUE_SOON");
    s.overdue = base(s.overdue) + n("OVERDUE");
    s.missingData = base(s.missingData) + n("MISSING_DATA");
    s.excluded = base(s.excluded) + n("EXCLUDED");
    s.totalEvaluated = baseTotal + groups.reduce((a, g) => a + g.count, 0);
    s.complianceRate = round1(s.compliant, s.totalEvaluated);
    if (tenant === "mhn") s.latestRunId = runId;
  }
}

function zeroSummary(s: ProgramSummary): void {
  s.totalEvaluated = 0; s.compliant = 0; s.dueSoon = 0; s.overdue = 0; s.missingData = 0;
  s.excluded = 0; s.complianceRate = 0; s.latestRunId = null; s.latestRunAt = null; s.openCaseCount = 0;
}

/** Run groups carrying site-filtered outcomes for one measure (bounded query, no per-run fan-out). */
async function runsWithOutcomes(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
): Promise<{ groups: RunGroup[]; directory: DirectorySnapshot; hasWebChartRows: boolean }> {
  const persistedRows = await deps.outcomeStore.listOutcomesWithRun({
      measureId,
      from: filters.from?.trim() || undefined,
      to: filters.to?.trim() || undefined,
      // E13 PR-2: trend + top-drivers are NOT extended to the scale tenant; exclude it in SQL so a
      // seeded measure's 120k rows never enter this scan (bounded) and never skew the live charts.
      excludeScale: true,
    });
  const successfulRows = persistedRows.filter((row) => isPopulationRun(row.runScopeType) && isCompletedRun(row.runStatus));
  const hasWebChartRows = successfulRows.some((row) => row.subjectId.startsWith("wc|"));
  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  const directory = directoryForRows(successfulRows, webChartConfigured);
  const siteMatch = siteMatcher(filters, directory.employeeById);
  const tenantMatch = tenantMatcher(filters, directory.employeeById);
  const rows = successfulRows.filter(
    (row) => subjectVisible(row.subjectId, webChartConfigured) && siteMatch(row.subjectId) && tenantMatch(row.subjectId),
  );
  return { groups: groupByRun(rows), directory, hasWebChartRows };
}

/** Last day of the (1-indexed) month in `YYYY-MM-DD`? `Date.UTC(y, m, 0)` = day 0 of month m's successor = last day of month m. */
function isLastDayOfMonth(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return false;
  return d === new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * True when a `[from, to]` range is whole-month-aligned (or unbounded) — the only ranges a month-
 * granular snapshot series can honor faithfully (`from` = a month's first day, `to` = a month's last
 * day). A partial-month range (e.g. a `2026-06-27..2026-07-04` preset) would otherwise pull in the
 * whole June + July snapshots while the day-granular overview/KPIs on the same card honor the exact
 * range — so `programTrend` falls back to the per-run path (which honors days) for partial ranges
 * (Codex P2).
 */
export function isWholeMonthRange(from?: string, to?: string): boolean {
  const firstDayOk = !from || Number(from.slice(8, 10)) === 1;
  const lastDayOk = !to || isLastDayOfMonth(to);
  return firstDayOk && lastDayOk;
}

/** A persisted monthly snapshot is safe seam-off only when its key structurally excludes WebChart. */
function monthlySnapshotScopeIsSafe(
  scope: { scopeLevel: QualityScopeLevel; scopeId: string },
  webChartConfigured: boolean,
  hasWebChartRows: boolean,
): boolean {
  if (webChartConfigured) return true;
  if (scope.scopeLevel === "all") return !hasWebChartRows;
  return scope.scopeId !== "wc" && !scope.scopeId.startsWith("wc|");
}

/** Per-run compliance trend for a measure — outcome-based, newest-first, capped at 10 (Java parity). */
export async function programTrend(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
  opts?: { monthly?: boolean },
): Promise<ProgramTrendPoint[]> {
  // UX-8: the monthly quality_snapshots series is OPT-IN (only the /programs card requests it via
  // ?granularity=month). Other consumers (the measure page, which has its own E16 "Quality over
  // time" card) keep the per-run trend unchanged. When opted in, the scope resolves, the range is
  // whole-month-aligned, and ≥2 months exist, return the monthly series; otherwise fall back to the
  // per-run trend below (which honors day-granular from/to).
  const from = filters.from?.trim() || undefined;
  const to = filters.to?.trim() || undefined;
  // Load once before the optional monthly early return: the same successful rows both rehydrate the
  // site-only scope after restart and feed the per-run fallback without a second store read.
  const { groups, directory, hasWebChartRows } = await runsWithOutcomes(deps, measureId, filters);
  const scope = opts?.monthly && deps.qualitySnapshots && isWholeMonthRange(from, to)
    ? snapshotScopeFor(filters, directory.employees)
    : null;
  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  if (
    opts?.monthly &&
    deps.qualitySnapshots &&
    scope &&
    monthlySnapshotScopeIsSafe(scope, webChartConfigured, hasWebChartRows)
  ) {
    const snaps = await deps.qualitySnapshots.querySnapshots({
      measureId,
      scopeLevel: scope.scopeLevel,
      scopeId: scope.scopeId,
      from: from?.slice(0, 7),
      to: to?.slice(0, 7),
    });
    const monthly = monthlyTrendPoints(snaps);
    if (monthly.length >= 2) return monthly;
  }

  // NOTE: Java unions a `run_based` branch for aggregate-only seeded runs; the TS floor `runs`
  // table has no compliant/total columns, so every TS run with data has outcomes — the
  // outcome-based branch is complete here.
  const n = (os: OutcomeWithRun[], s: string) => os.filter((o) => o.status === s).length;
  return groups
    .map(({ runId, runStartedAt, rows }): ProgramTrendPoint => {
      const total = rows.length;
      const compliant = n(rows, "COMPLIANT");
      return {
        runId,
        startedAt: runStartedAt,
        complianceRate: round1(compliant, total),
        totalEvaluated: total,
        compliant,
        dueSoon: n(rows, "DUE_SOON"),
        overdue: n(rows, "OVERDUE"),
        missingData: n(rows, "MISSING_DATA"),
        excluded: n(rows, "EXCLUDED"),
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 10);
}

/** Overdue concentration (site/role) + flagged-reason mix for a measure's latest filtered run. */
export async function programTopDrivers(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
): Promise<TopDrivers> {
  const empty: TopDrivers = { bySite: [], byRole: [], byOutcomeReason: [] };
  const { groups, directory } = await runsWithOutcomes(deps, measureId, filters);
  if (groups.length === 0) return empty;
  // Latest filtered run with outcomes for this measure.
  const latest = groups.reduce((a, b) => (b.runStartedAt > a.runStartedAt ? b : a));
  const outcomes = latest.rows;

  const overdue = outcomes.filter((o) => o.status === "OVERDUE");
  const tally = (key: (subjectId: string) => string) => {
    const counts = new Map<string, number>();
    for (const o of overdue) {
      const k = key(o.subjectId);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };
  const siteCounts = tally((id) => directory.employeeById(id)?.site ?? "");
  const roleCounts = tally((id) => directory.employeeById(id)?.role ?? "");

  const bySite = [...siteCounts.entries()]
    .map(([site, overdueCount]) => ({ site, overdueCount, note: "High overdue concentration" }))
    .sort((a, b) => b.overdueCount - a.overdueCount || a.site.localeCompare(b.site))
    .slice(0, 5);
  const byRole = [...roleCounts.entries()]
    .map(([role, overdueCount]) => ({ role, overdueCount }))
    .sort((a, b) => b.overdueCount - a.overdueCount || a.role.localeCompare(b.role))
    .slice(0, 5);

  const FLAGGED = new Set(["OVERDUE", "MISSING_DATA", "DUE_SOON"]);
  const flagged = outcomes.filter((o) => FLAGGED.has(o.status));
  const totalFlagged = flagged.length;
  const reasonCounts = new Map<string, number>();
  for (const o of flagged) reasonCounts.set(o.status, (reasonCounts.get(o.status) ?? 0) + 1);
  const byOutcomeReason = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count, pct: totalFlagged === 0 ? 0 : Math.round((count / totalFlagged) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);

  return { bySite, byRole, byOutcomeReason };
}

// ---- risk outlook (#107) ----------------------------------------------------
const DUE_SOON_BUFFER_DAYS = 30;
const pct1 = (num: number, den: number) => (den <= 0 ? 0 : Math.round((num / den) * 1000) / 10);
const daysBetween = (fromIso: string, toIso: string) =>
  Math.floor((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** last_exam_date from the recency define (same derivation as case detail); null if no real exam. */
function lastExamDateOf(evidence: unknown): string | null {
  const er = (evidence as { expressionResults?: Array<{ define: string; result: unknown }> } | null)?.expressionResults;
  const recent = Array.isArray(er) ? er.find((r) => /^most recent .*date$/i.test(r.define)) : undefined;
  return recent && typeof recent.result === "string" ? recent.result.slice(0, 10) : null;
}

/**
 * Predictive risk outlook for a measure (TS port of RiskOutlookService): who becomes DUE_SOON
 * within the horizon, repeat non-compliers (OVERDUE/MISSING_DATA streak ≥ 3 across periods),
 * and per-site current vs predicted compliance. Returns null for an unknown measure (→ 404).
 */
export async function programRiskOutlook(
  deps: ProgramDeps,
  measureId: string,
  horizonDays: number,
): Promise<RiskOutlook | null> {
  const measure = MEASURE_CATALOG.find((m) => m.id === measureId);
  if (!measure) return null;
  const horizon = Math.max(1, Math.min(Number.isFinite(horizonDays) ? Math.trunc(horizonDays) : 30, 180));
  const window = MEASURE_BINDINGS[measureId]?.complianceWindowDays ?? 365;
  const today = new Date().toISOString().slice(0, 10);
  // One evidence-rich query retains only terminal successful population runs. This keeps FAILED,
  // RUNNING, CASE, and EMPLOYEE outcomes from affecting status/streaks/directory visibility without
  // the unbounded listOutcomes-per-historical-run hydration pass. Scale rows are also dropped in SQL.
  const rows = await deps.outcomeStore.listOutcomesForMeasure(measureId, {
    excludeScale: true,
    successfulPopulationOnly: true,
  });
  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  const directory = directoryForRows(rows, webChartConfigured);
  const visibleRows = rows.filter((row) => subjectVisible(row.subjectId, webChartConfigured));

  // Latest outcome per subject (rows arrive oldest-first, so the last write wins).
  const latestBySubject = new Map<string, MeasureOutcomeRow>();
  for (const r of visibleRows) latestBySubject.set(r.subjectId, r);

  const siteAcc = new Map<string, { total: number; compliant: number; upcoming: number }>();
  const upcomingExpirations: RiskOutlook["upcomingExpirations"] = [];
  for (const snap of latestBySubject.values()) {
    const emp = directory.employeeById(snap.subjectId);
    const site = emp?.site || "Unknown";
    const acc = siteAcc.get(site) ?? siteAcc.set(site, { total: 0, compliant: 0, upcoming: 0 }).get(site)!;
    acc.total++;
    if (snap.status === "COMPLIANT") acc.compliant++;

    const lastExam = lastExamDateOf(snap.evidence);
    if (snap.status !== "COMPLIANT" || !lastExam) continue;
    const threshold = Math.max(window - DUE_SOON_BUFFER_DAYS, 0);
    const daysSince = daysBetween(lastExam, today);
    if (daysSince >= threshold) continue;
    const daysUntil = threshold - daysSince;
    if (daysUntil > horizon) continue;
    acc.upcoming++;
    upcomingExpirations.push({
      externalId: snap.subjectId,
      name: emp?.name ?? snap.subjectId,
      site,
      measureName: measure.name,
      lastExamDate: lastExam,
      complianceWindowDays: window,
      daysSinceLastExam: daysSince,
      daysUntilDueSoon: daysUntil,
      predictedDueSoonDate: addDays(lastExam, threshold),
    });
  }
  upcomingExpirations.sort((a, b) => a.daysUntilDueSoon - b.daysUntilDueSoon || a.name.localeCompare(b.name));

  const siteComplianceRates = [...siteAcc.entries()]
    .map(([site, a]) => ({
      site,
      total: a.total,
      compliant: a.compliant,
      upcomingExpirations: a.upcoming,
      currentComplianceRate: pct1(a.compliant, a.total),
      predictedComplianceRate: pct1(Math.max(0, a.compliant - a.upcoming), a.total),
    }))
    .sort((a, b) => a.currentComplianceRate - b.currentComplianceRate);

  // Repeat non-compliers: per subject, dedupe to the latest outcome per evaluation_period, order
  // newest-first, count the leading OVERDUE/MISSING_DATA streak; keep streak ≥ 3 (top 10).
  const bySubject = new Map<string, MeasureOutcomeRow[]>();
  for (const r of visibleRows) (bySubject.get(r.subjectId) ?? bySubject.set(r.subjectId, []).get(r.subjectId)!).push(r);
  const FLAGGED = new Set(["OVERDUE", "MISSING_DATA"]);
  const repeatNonCompliers = [...bySubject.entries()]
    .map(([subjectId, subjectRows]) => {
      const latestPerPeriod = new Map<string, MeasureOutcomeRow>();
      for (const r of subjectRows) {
        const prev = latestPerPeriod.get(r.evaluationPeriod);
        if (!prev || r.evaluatedAt > prev.evaluatedAt) latestPerPeriod.set(r.evaluationPeriod, r);
      }
      const ordered = [...latestPerPeriod.values()].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
      let streak = 0;
      for (const r of ordered) {
        if (!FLAGGED.has(r.status)) break;
        streak++;
      }
      const emp = directory.employeeById(subjectId);
      return { externalId: subjectId, name: emp?.name ?? subjectId, site: emp?.site || "Unknown", measureName: measure.name, streakCount: streak };
    })
    .filter((r) => r.streakCount >= 3)
    .sort((a, b) => b.streakCount - a.streakCount || a.name.localeCompare(b.name))
    .slice(0, 10);

  return { upcomingNonCompliantCount: upcomingExpirations.length, upcomingExpirations, repeatNonCompliers, siteComplianceRates };
}
