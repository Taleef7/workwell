/**
 * Programs read models (#107 programs module) — the `/programs` dashboard's overview +
 * site list, ported from ProgramService.listPrograms / listSites.
 *
 * Overview, per Active measure: the LATEST run (filtered by employee site + run period)
 * that produced outcomes for that measure, its outcome-bucket counts, complianceRate
 * (compliant / (total - excluded) × 100, 1 decimal), and the OPEN case count (same site/period filter on
 * the case). Active measures are the catalog's Active set = the engine's runnable set.
 * Employee site is resolved from the synthetic directory (outcomes carry only subjectId).
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, OutcomeWithRun, OutcomeMeasureFilter } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { QualitySnapshotStore, QualitySnapshotRow, QualityScopeLevel } from "../stores/quality-snapshot-store.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { measureIdentityFor } from "../measure/measure-identity.ts";
import { ACTIVE_CASE_STATUSES } from "../case/case-logic.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { day, isCompletedRun, round1, complianceRateOf, type ComplianceRateCounts } from "./rollup-shared.ts";
import { officialMeasureRate, type MeasureRate } from "./measure-rate.ts";
import { directoryForRows, type DirectorySnapshot } from "../engine/ingress/webchart/live-directory.ts";
import { DEPLOYMENT_PROFILE, DIRECTORY, isRunnableMeasure, profileSubjectMatcher, tenantById } from "../config/deployment-profile.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { isOfficialRouted } from "../wiring/official-routing.ts";
import { latestPopulationSnapshot, latestPopulationWinners, RunKeyedMemo, type VisibilityContext } from "./latest-population.ts";
import type { LatestPopulationRun } from "../stores/outcome-store.ts";

export { complianceRateOf, type ComplianceRateCounts };

export interface ProgramSummary {
  measureId: string;
  measureName: string;
  policyRef: string;
  version: string;
  latestRunId: string | null;
  latestRunAt: string | null;
  totalEvaluated: number;
  denominator: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  /**
   * Subjects the measure's own logic put OUTSIDE its initial population (ADR-078) — persisted
   * MISSING_DATA, separated here by the same evidence the roster cell reads. NOT part of
   * `missingData`, and NOT in `complianceRate`'s denominator: on the pilot this was the whole
   * Missing Data column, and counting it as unmet work reported CMS125 at 18.0% for a population
   * that scores 72.1%. Always 0 for an authored measure, which has no population membership.
   */
  notInPopulation: number;
  excluded: number;
  complianceRate: number;
  /**
   * Which way the measure improves (`MEASURE_IDENTITY`; "increase" when the measure has no identity
   * row). Carried on the summary so a client can render an inverse measure (cms122: the numerator is
   * poor control) from this one response, never depending on `/api/measures` resolving first.
   */
  improvementNotation: "increase" | "decrease";
  openCaseCount: number;
  /**
   * The EVIDENCE's rate for `latestRunId` — the measure's own populations reduced by the same
   * aggregator the MeasureReport uses — or null when the run carries no official evidence. Shown as a
   * separate metric from `complianceRate`, which is the workflow-status rate (ADR-077 d5).
   */
  measureRate: MeasureRate | null;
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
 * `complianceRate` uses the CMS proportion denominator (`total − excluded`), while `totalEvaluated`
 * keeps reporting the full evaluated count including excluded (a count, not a denominator).
 */
export function monthlyTrendPoints(rows: QualitySnapshotRow[]): ProgramTrendPoint[] {
  return rows
    .slice()
    .sort((a, b) => b.period.localeCompare(a.period)) // newest-first, matching the per-run path's contract
    .slice(0, 12)
    .map((r): ProgramTrendPoint => {
      const total = r.compliant + r.dueSoon + r.overdue + r.missingData + r.excluded;
      const denominator = total - r.excluded;
      return {
        runId: r.sourceRunId ?? r.id,
        startedAt: r.periodEnd,
        period: r.period,
        complianceRate: complianceRateOf({
          compliant: r.compliant,
          dueSoon: r.dueSoon,
          overdue: r.overdue,
          missingData: r.missingData,
          excluded: r.excluded,
        }),
        totalEvaluated: total,
        denominator,
        compliant: r.compliant,
        dueSoon: r.dueSoon,
        overdue: r.overdue,
        missingData: r.missingData,
        // A quality snapshot records five status counts and has no column for the split (ADR-079
        // put the flag on `outcomes`, not here). That is sound only because this series is never
        // served for a measure whose runs can PRODUCE out-of-population rows — `programTrend`
        // refuses the monthly branch for an official-routed measure and falls through to the
        // per-run points, which read the flag. Zero here is therefore the true count, not a
        // placeholder; if the monthly branch is ever widened, this becomes a real gap.
        notInPopulation: 0,
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
  denominator: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  /**
   * Subjects outside the measure's population (ADR-079) — out of `missingData` and out of
   * `denominator`, so this point is on the same basis as the overview's headline. A monthly point
   * carries the snapshot's own recorded figure; see `monthlyTrendPoints`.
   */
  notInPopulation: number;
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

/** The measures a roster-wide read model shows: catalog-Active AND runnable on this deployment. */
const activeRunnableIds = (): string[] =>
  MEASURE_CATALOG.filter((m) => m.status === "Active" && isRunnableMeasure(m.id)).map((m) => m.id);

const LATEST_FILTER = { excludeScale: true, excludeTrendHistory: true } as const;

/**
 * The dashboard shell asks for the site list on EVERY page load, so this is the read every page paid:
 * on the pilot it was every retained outcome row (~1M) to produce five clinic names. Now: no read at
 * all where the static directory is the answer, and otherwise the winners' rows once per nightly.
 */
const sitesMemo = new RunKeyedMemo<string[]>(4);
export const __sitesMemo = sitesMemo;

/** Distinct sites from one restart-safe snapshot of the latest successful population rows. */
export async function programSites(deps: Pick<ProgramDeps, "outcomeStore" | "webChartEnv">): Promise<string[]> {
  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  // With the WebChart seam off, `directoryForRows` returns the static directory whatever rows it is
  // handed, and the default profile lists that directory's sites — so the rows were never consulted.
  // Byte-identical to the read this replaces; the read is simply not made.
  if (DEPLOYMENT_PROFILE.id === "default" && !webChartConfigured) return listSites(DIRECTORY.employees);
  const active = activeRunnableIds();
  const { winners, runKey } = await latestPopulationWinners(deps.outcomeStore, active, LATEST_FILTER);
  const memoKey = `sites:${webChartConfigured}`; // the seam state decides visibility, so it keys the memo
  const hit = sitesMemo.get(memoKey, runKey);
  if (hit) return hit;
  // The scoped-profile site list's own visibility rule (seam + profile), so a winner none of whose
  // subjects are visible falls back exactly as the filter-then-reduce it replaces did.
  const snap = await latestPopulationSnapshot(deps.outcomeStore, active, LATEST_FILTER, deps.webChartEnv, 1, {
    precomputed: winners,
    visible: DEPLOYMENT_PROFILE.id === "default" ? undefined : (id, ctx) => subjectVisible(id, ctx.webChartConfigured) && ctx.profileMatch(id),
  });
  const rows = snap.rows.filter((row) => row.runTriggeredBy !== "seed:scale");
  // A fallback result is never memoized (see `fellBack`): its answer can move while the winners stay.
  const remember = (sites: string[]): string[] => (snap.fellBack ? sites : sitesMemo.set(memoKey, runKey, sites));
  if (DEPLOYMENT_PROFILE.id === "default") return remember(listSites(snap.directory.employees));
  const visibleRows = rows.filter((row) => subjectVisible(row.subjectId, snap.webChartConfigured) && snap.profileMatch(row.subjectId));
  const employees = visibleRows.map((r) => snap.directory.employeeById(r.subjectId)).filter((e): e is EmployeeProfile => e !== null);
  return remember(listSites(employees));
}

/** One run's site-filtered outcome rows (the unit overview/trend/top-drivers aggregate). */
interface RunGroup {
  runId: string;
  runStartedAt: string;
  runStatus: string;
  rows: OutcomeWithRun[];
}

/** Group site-filtered outcome rows by run (only runs with ≥1 matching row). */
function groupByRun(rows: OutcomeWithRun[]): RunGroup[] {
  const byRun = new Map<string, RunGroup>();
  for (const r of rows) {
    let g = byRun.get(r.runId);
    if (!g) byRun.set(r.runId, (g = { runId: r.runId, runStartedAt: r.runStartedAt, runStatus: r.runStatus, rows: [] }));
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

/**
 * On scoped profiles (e.g. Maui), isolate data by excluding subjects that do not resolve in the
 * profile directory. On the default profile, this is a no-op: a TWH database legitimately holds
 * non-catalog subjects (notably QRDA Category I imports keyed by Cypress MRNs), which must not be
 * silently dropped from /api/programs.
 */
/** Hide only live-tenant ids when the existing runtime seam is off; all non-wc legacy behavior stays unchanged. */
const subjectVisible = (subjectId: string, webChartConfigured: boolean): boolean =>
  webChartConfigured || !subjectId.startsWith("wc|");

/** The outcome-derived half of a ProgramSummary — what the winners' immutable rows determine. */
interface OverviewBuckets {
  latestRunId: string | null;
  latestRunAt: string | null;
  total: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  notInPopulation: number;
  excluded: number;
}
const EMPTY_BUCKETS: OverviewBuckets = { latestRunId: null, latestRunAt: null, total: 0, compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, notInPopulation: 0, excluded: 0 };
const overviewMemo = new RunKeyedMemo<{ buckets: Map<string, OverviewBuckets>; directory: DirectorySnapshot; webChartConfigured: boolean }>(16);
export const __overviewMemo = overviewMemo;

export async function programOverview(deps: ProgramDeps, filters: ProgramFilters): Promise<ProgramSummary[]> {
  const from = filters.from?.trim() || null;
  const to = filters.to?.trim() || null;
  const inPeriod = (iso: string): boolean => (!from || day(iso) >= day(from)) && (!to || day(iso) <= day(to));

  const active = MEASURE_CATALOG.filter((m) => m.status === "Active" && isRunnableMeasure(m.id));
  // The winners first (O(measures) rows), then their rows ONCE per nightly: the status buckets below
  // are a pure function of the winning runs' immutable outcomes and the request's filters, so they
  // are memoized under the winners' key. Everything that reads a mutable table — the open-case
  // count, the scale fold, the measure's rate memo — is computed below, per request, as before.
  // Only terminal (COMPLETED/PARTIAL_FAILURE) population runs can be a measure's "latest run": an
  // in-flight ALL_PROGRAMS run writes outcomes incrementally, and without that rule the newest group
  // was the RUNNING run with PARTIAL counts — the headline Evaluations number visibly bounced.
  // excludeScale keeps the scale tenant's rows in SQL (folded in via aggregateScaleRun below);
  // excludeTrendHistory keeps the backdated synthetic trend rows out (they are never a winner). The
  // /programs TREND read model below intentionally keeps them.
  const latestFilter = { from: from ?? undefined, to: to ?? undefined, ...LATEST_FILTER };
  const { winners, runKey } = await latestPopulationWinners(deps.outcomeStore, active.map((m) => m.id), latestFilter);
  // The seam state is part of the key: it decides which subjects are visible and which directory
  // resolves them, so a request after the seam flips must not be served the other state's buckets.
  const memoKey = JSON.stringify([from, to, filters.site?.trim() || null, filters.tenant?.trim() || null, isWebChartConfigured(deps.webChartEnv ?? {})]);
  let derived = overviewMemo.get(memoKey, runKey);
  if (!derived) {
    // The overview's own row filter, handed to the snapshot as its visibility rule: the old code
    // filtered history by seam/profile/site/tenant and THEN took the newest run, so a newer run with
    // no row at the requested site fell through to the newest that had one. Same here, per measure.
    const snap = await latestPopulationSnapshot(deps.outcomeStore, active.map((m) => m.id), latestFilter, deps.webChartEnv, 1, {
      precomputed: winners,
      visible: rowVisibleUnder(filters),
    });
    const successfulRows = snap.rows.filter((row) => row.runTriggeredBy !== "seed:scale");
    const siteMatch = siteMatcher(filters, snap.directory.employeeById);
    const tenantMatch = tenantMatcher(filters, snap.directory.employeeById);
    const rows = successfulRows.filter(
      (row) =>
        subjectVisible(row.subjectId, snap.webChartConfigured) &&
        snap.profileMatch(row.subjectId) &&
        siteMatch(row.subjectId) &&
        tenantMatch(row.subjectId),
    );
    const byMeasure = new Map<string, OutcomeWithRun[]>();
    for (const r of rows) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
    const buckets = new Map<string, OverviewBuckets>();
    for (const m of active) {
      const groups = groupByRun(byMeasure.get(m.id) ?? []);
      const best = groups.length ? groups.reduce((a, b) => (b.runStartedAt > a.runStartedAt ? b : a)) : null;
      const os = best?.rows ?? [];
      const n = (status: string) => os.filter((o) => o.status === status).length;
      // Out-of-population is a REFINEMENT of MISSING_DATA (ADR-078) that the status alone cannot
      // carry, so the run writes it down and this counts the column (ADR-079). A row whose run
      // predates the column reads `undefined` and counts as in-population — the pre-ADR-079 answer,
      // which is what keeps an un-backfilled deployment reporting what it reported before rather
      // than something new and wrong. `docs/DEPLOY.md` carries the backfill.
      //
      // `o.status === "MISSING_DATA"` is not redundant defence: the subtraction below is from the
      // MISSING_DATA count, and there is no UNIQUE on (run_id, subject_id, measure_id), so a run that
      // persisted a subject twice under different statuses could otherwise drive it negative.
      const notInPopulation = os.reduce((acc, o) => acc + (o.outOfPopulation === true && o.status === "MISSING_DATA" ? 1 : 0), 0);
      buckets.set(m.id, {
        latestRunId: best?.runId ?? null,
        latestRunAt: best?.runStartedAt ?? null,
        total: os.length,
        compliant: n("COMPLIANT"),
        dueSoon: n("DUE_SOON"),
        overdue: n("OVERDUE"),
        // The remainder: subjects who ARE in the population and whose data is missing — the ones a
        // panel can act on. Non-negative because `notInPopulation` is counted over the same rows with
        // the same status conjunct, four lines above.
        missingData: n("MISSING_DATA") - notInPopulation,
        notInPopulation,
        excluded: n("EXCLUDED"),
      });
    }
    derived = { buckets, directory: snap.directory, webChartConfigured: snap.webChartConfigured };
    // A fallback result is never memoized (see `fellBack`): its answer can move while the winners stay.
    if (!snap.fellBack) overviewMemo.set(memoKey, runKey, derived);
  }
  const { directory, webChartConfigured } = derived;
  const siteMatch = siteMatcher(filters, directory.employeeById);
  const tenantMatch = tenantMatcher(filters, directory.employeeById);
  const profileMatch = profileSubjectMatcher(directory.employeeById);
  // Active cases only: the count below keeps ACTIVE_CASE_STATUSES, so the closed majority (the pilot
  // closes ~15,000 under OUT_OF_POPULATION in one pass) was fetched to be discarded.
  const cases = await deps.caseStore.listCases({ statuses: [...ACTIVE_CASE_STATUSES], limit: 100000 });

  const summaries = active.map((m): ProgramSummary => {
    const b = derived!.buckets.get(m.id) ?? EMPTY_BUCKETS;
    const best = b.latestRunId ? { runId: b.latestRunId, runStartedAt: b.latestRunAt! } : null;
    const { total, compliant, dueSoon, overdue, missingData, notInPopulation, excluded } = b;
    // The proportion denominator drops the subjects the measure does not describe as well as the
    // excluded ones — `totalEvaluated` still reports every row the run wrote.
    const denominator = total - excluded - notInPopulation;
    const openCaseCount = cases.filter(
      (c) =>
        c.measureId === m.id &&
        (ACTIVE_CASE_STATUSES as readonly string[]).includes(c.status) &&
        subjectVisible(c.employeeId, webChartConfigured) &&
        profileMatch(c.employeeId) &&
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
      denominator,
      compliant,
      dueSoon,
      overdue,
      missingData,
      notInPopulation,
      excluded,
      complianceRate: complianceRateOf({ compliant, dueSoon, overdue, missingData, excluded }),
      improvementNotation: measureIdentityFor(m.id)?.improvementNotation ?? "increase",
      openCaseCount,
      measureRate: null,
    };
  });

  // E13 PR-2: fold in the population-scale mhn tenant's per-measure counts via SQL aggregation
  // (the in-memory scan above excluded seed:scale runs). When ?tenant=mhn, REPLACE the live counts
  // with the scale ones; otherwise ADD them. Skipped when scoped to a non-mhn tenant.
  await foldScaleCounts(deps, summaries, filters);

  // The evidence's rate, per measure, off the winning run (ADR-077 d5). Sequential and memoized: one
  // paged read per (run, measure) for the life of the process, and an authored run costs one row
  // (`runProducedOfficialEvidence`). Deliberately NOT site/tenant-filtered: it is the run's whole
  // population, which is what the export reports; a filtered view keeps the status buckets only.
  for (const s of summaries) {
    if (s.latestRunId) s.measureRate = await officialMeasureRate(deps.outcomeStore, s.latestRunId, s.measureId);
  }

  return summaries.sort((a, b) => a.measureName.localeCompare(b.measureName));
}

const SCALE_TENANT_ID = "mhn";

/** Add (or, for ?tenant=mhn, replace with) the scale tenant's per-measure counts from the latest
 *  seed:scale run per measure. Bounded — aggregateScaleRun never materializes the per-subject rows.
 *  Skipped when a site filter is active (scale data has no equivalent site dimension) or when the
 *  date window excludes the scale run's startedAt (keeps filtered KPIs consistent). */
async function foldScaleCounts(deps: ProgramDeps, summaries: ProgramSummary[], filters: ProgramFilters): Promise<void> {
  // Scale counts are pre-aggregated in SQL across subjects, so row-level profile filtering
  // provably cannot reach them; skip when the scale tenant is not visible on this deployment.
  if (!tenantById(SCALE_TENANT_ID)) return;
  const tenant = filters.tenant?.trim() || null;
  if (tenant && tenant !== SCALE_TENANT_ID) return; // scoped to a non-scale tenant → no scale data
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
      if (tenant === SCALE_TENANT_ID) zeroSummary(s); // mhn-scoped but no scale data for this measure
      continue;
    }
    const groups = await deps.outcomeStore.aggregateScaleRun(runId);
    const n = (st: string) => groups.filter((g) => g.status === st).reduce((a, g) => a + g.count, 0);
    const baseTotal = tenant === SCALE_TENANT_ID ? 0 : s.totalEvaluated;
    const base = (cur: number) => (tenant === SCALE_TENANT_ID ? 0 : cur);
    s.compliant = base(s.compliant) + n("COMPLIANT");
    s.dueSoon = base(s.dueSoon) + n("DUE_SOON");
    s.overdue = base(s.overdue) + n("OVERDUE");
    s.missingData = base(s.missingData) + n("MISSING_DATA");
    // The generated scale tenant runs the AUTHORED engine, so none of its rows carries population
    // membership and none can be out of population. The live half's count is kept as it is (or
    // dropped with the rest of the live counts when the view is scoped to the scale tenant).
    s.notInPopulation = base(s.notInPopulation);
    s.excluded = base(s.excluded) + n("EXCLUDED");
    s.totalEvaluated = baseTotal + groups.reduce((a, g) => a + g.count, 0);
    s.denominator = s.totalEvaluated - s.excluded - s.notInPopulation;
    s.complianceRate = complianceRateOf(s);
    if (tenant === SCALE_TENANT_ID) s.latestRunId = runId;
  }
}

function zeroSummary(s: ProgramSummary): void {
  s.totalEvaluated = 0; s.denominator = 0; s.compliant = 0; s.dueSoon = 0; s.overdue = 0; s.missingData = 0;
  s.notInPopulation = 0; s.excluded = 0; s.complianceRate = 0; s.latestRunId = null; s.latestRunAt = null; s.openCaseCount = 0;
}

/**
 * The trend shows at most 10 points (Java parity), so it starts from the newest 10 completed
 * population runs holding the measure — not the measure's whole history, which on the pilot is
 * every nightly since the flip, twice (the trend and top-drivers each read it) — and widens the
 * window (see `programTrend`) when the same-day collapse or the site/tenant filter leaves fewer
 * than ten displayable points. The pilot's ALL_PROGRAMS nightly holds every measure at every clinic,
 * so there the first window is the last.
 */
const TREND_RUN_WINDOW = 10;

/** The per-measure filter trend + top-drivers share: the request window, scale kept out in SQL.
 *  Trend history is deliberately NOT excluded — those backdated runs are the trend's early points. */
const measureFilter = (filters: ProgramFilters): OutcomeMeasureFilter => ({
  from: filters.from?.trim() || undefined,
  to: filters.to?.trim() || undefined,
  // E13 PR-2: trend + top-drivers are NOT extended to the scale tenant; exclude it in SQL so a
  // seeded measure's 120k rows never enter this scan (bounded) and never skew the live charts.
  excludeScale: true,
});

/** The row filter the overview, trend and top-drivers apply after the read (seam, profile, site,
 *  tenant), in the form the snapshot helper takes so a winner with no visible row falls back. */
const rowVisibleUnder = (filters: ProgramFilters) => (subjectId: string, ctx: VisibilityContext): boolean =>
  subjectVisible(subjectId, ctx.webChartConfigured) &&
  ctx.profileMatch(subjectId) &&
  siteMatcher(filters, ctx.directory.employeeById)(subjectId) &&
  tenantMatcher(filters, ctx.directory.employeeById)(subjectId);

/** Run groups carrying site-filtered outcomes for one measure — its newest `runWindow` completed
 *  population runs, resolved from the runs table first and read by run id, narrowed to the measure
 *  (never the history, never the run's other measures). */
async function runsWithOutcomes(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
  runWindow: number,
  precomputed?: readonly LatestPopulationRun[],
): Promise<{ groups: RunGroup[]; directory: DirectorySnapshot; hasWebChartRows: boolean; runsFound: number; fellBack: boolean }> {
  const snap = await latestPopulationSnapshot(deps.outcomeStore, [measureId], measureFilter(filters), deps.webChartEnv, runWindow, {
    precomputed,
    visible: rowVisibleUnder(filters),
  });
  const successfulRows = snap.rows;
  const hasWebChartRows = successfulRows.some((row) => row.subjectId.startsWith("wc|"));
  const siteMatch = siteMatcher(filters, snap.directory.employeeById);
  const tenantMatch = tenantMatcher(filters, snap.directory.employeeById);
  const rows = successfulRows.filter(
    (row) =>
      subjectVisible(row.subjectId, snap.webChartConfigured) &&
      snap.profileMatch(row.subjectId) &&
      siteMatch(row.subjectId) &&
      tenantMatch(row.subjectId),
  );
  return { groups: groupByRun(rows), directory: snap.directory, hasWebChartRows, runsFound: snap.winners.length, fellBack: snap.fellBack };
}

/** Memo key for the per-measure charts: the measure, every request filter that shapes them, and the
 *  seam state (it decides which subjects are visible, so a seam flip must not serve the other's points). */
const chartMemoKey = (deps: ProgramDeps, measureId: string, filters: ProgramFilters, extra: unknown = null): string =>
  JSON.stringify([
    measureId, filters.from?.trim() || null, filters.to?.trim() || null, filters.site?.trim() || null, filters.tenant?.trim() || null,
    isWebChartConfigured(deps.webChartEnv ?? {}), extra,
  ]);
const trendMemo = new RunKeyedMemo<ProgramTrendPoint[]>(64);
const driversMemo = new RunKeyedMemo<TopDrivers>(64);
/**
 * The risk outlook's memo lives here, with its siblings, rather than beside the function that uses
 * it — so that a `reset()` helper iterating `Object.values(__chartMemos)` clears it without being
 * told about it. A per-measure memo a test helper does not know about is cross-test pollution waiting
 * to happen, and the type is hoisted so the declaration order costs nothing.
 *
 * Reviewed caveat: this only helps the helpers that ITERATE. `latest-population.test.ts` clears
 * `trendMemo`/`driversMemo` by name, so it would not clear this one — it calls no outlook code today,
 * and the clears there were converted to the iterating form so that the first test which does cannot
 * silently inherit a warm entry.
 */
const outlookMemo = new RunKeyedMemo<OutlookBase>(32);
export const __chartMemos = { trendMemo, driversMemo, outlookMemo };

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
  // Snapshot keys carry no deployment-profile dimension and pre-aggregate across subjects in SQL,
  // so row-level predicates cannot reach them; scoped profiles must fall back to the per-run trend.
  if (DEPLOYMENT_PROFILE.id !== "default") return false;
  if (webChartConfigured) return true;
  if (scope.scopeLevel === "all") return !hasWebChartRows;
  return scope.scopeId !== "wc" && !scope.scopeId.startsWith("wc|");
}

function createDayFormatter(tz?: string): Intl.DateTimeFormat {
  let timeZone = "UTC";
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
      timeZone = tz;
    } catch {
      timeZone = "UTC";
    }
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Per-run compliance trend for a measure — outcome-based, newest-first, capped at 10 (Java parity).
 *  Includes completed runs (COMPLETED or PARTIAL_FAILURE per isCompletedRun) so the headline
 *  and "from previous" compare like with like; FAILED and non-completed runs are excluded. */
export async function programTrend(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
  opts?: { monthly?: boolean; tz?: string },
): Promise<ProgramTrendPoint[]> {
  // UX-8: the monthly quality_snapshots series is OPT-IN (only the /programs card requests it via
  // ?granularity=month). Other consumers (the measure page, which has its own E16 "Quality over
  // time" card) keep the per-run trend unchanged. When opted in, the scope resolves, the range is
  // whole-month-aligned, and ≥2 months exist, return the monthly series; otherwise fall back to the
  // per-run trend below (which honors day-granular from/to).
  const from = filters.from?.trim() || undefined;
  const to = filters.to?.trim() || undefined;
  // The per-run points are a pure function of the window's immutable runs, so they are memoized under
  // the window's key. The monthly branch reads the quality-snapshot store (mutable, and only ever
  // taken on the default profile — `monthlySnapshotScopeIsSafe`), so a request that could take it
  // bypasses the memo entirely rather than serve per-run points where monthly ones were due.
  // `!isOfficialRouted` belongs here as well as on the branch below: without it, an official-routed
  // measure on the default profile is neither served monthly NOR memoized — `monthlyPossible` would
  // suppress the memo read AND the memo write for a request that then falls through to the per-run
  // points, throwing the computed result away on every request and leaving `warmReadModels`' monthly
  // pass warming nothing.
  const monthlyPossible = Boolean(opts?.monthly && deps.qualitySnapshots && DEPLOYMENT_PROFILE.id === "default" && !isOfficialRouted(measureId));
  const { winners, runKey } = await latestPopulationWinners(deps.outcomeStore, [measureId], measureFilter(filters), TREND_RUN_WINDOW);
  const memoKey = chartMemoKey(deps, measureId, filters, opts?.tz ?? null);
  const cached = monthlyPossible ? undefined : trendMemo.get(memoKey, runKey);
  if (cached) return cached;
  // Load once before the optional monthly early return: the same successful rows both rehydrate the
  // site-only scope after restart and feed the per-run fallback without a second store read.
  const first = await runsWithOutcomes(deps, measureId, filters, TREND_RUN_WINDOW, winners);
  const { directory, hasWebChartRows } = first;
  const scope = opts?.monthly && deps.qualitySnapshots && isWholeMonthRange(from, to)
    ? snapshotScopeFor(filters, directory.employees)
    : null;
  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  // NOT for a measure whose rows can be out of population. The monthly series is the aggregate
  // snapshot store, whose rows carry five status counts and no record of which of them were outside
  // the measure's population — so for such a measure it would report the pre-ADR-079 rate directly
  // beneath a headline computed on the corrected one, and the card's own delta would be the
  // difference between the two bases rather than a change over time. The per-run points below read
  // the persisted flag and are correct, so falling through is a right answer rather than a missing one.
  //
  // The condition is what the ROWS say, not what today's env says. `isOfficialRouted` reads
  // `WORKWELL_OFFICIAL_MEASURES`, and a rollback after official runs were written is a case the
  // roster cell already documents as real — under exactly that sequence an env-only guard reopens the
  // monthly branch for a measure whose snapshots DO fold out-of-population into `missingData`.
  //
  // Bounded by the trend window, and knowingly so: if routing were rolled back AND every flagged run
  // aged out of that window AND pre-ADR-079 snapshots survived, the monthly branch reopens. Widening
  // it means a second unbounded read on a path whose entire purpose is to avoid one, and the
  // alternative heuristics (inferring from a snapshot's own counts) are guesses about data rather
  // than statements about it. Recorded rather than papered over.
  const producedOutOfPopulation = first.groups.some((g) => g.rows.some((r) => r.outOfPopulation === true));
  if (
    opts?.monthly &&
    deps.qualitySnapshots &&
    scope &&
    !isOfficialRouted(measureId) &&
    !producedOutOfPopulation &&
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
  //
  // The window is widened until ten DISPLAYABLE points exist or the history is exhausted: the
  // site/tenant filter and the same-day collapse below can each spend a run of the window on a
  // point that never shows, and the old all-history read always found the older days beyond them.
  // Doubling stops at TREND_RUN_WINDOW_MAX, and at a read that returned fewer runs than it asked
  // for (nothing older exists). The memo key stays the newest ten's — a wider window changes only
  // when they do, or when an older run completes, which the next nightly's new winner refreshes.
  let read = first;
  let window = TREND_RUN_WINDOW;
  let points = trendPointsOf(read.groups, opts?.tz);
  while (points.length < 10 && read.runsFound >= window && window < TREND_RUN_WINDOW_MAX) {
    window = Math.min(window * 2, TREND_RUN_WINDOW_MAX);
    read = await runsWithOutcomes(deps, measureId, filters, window);
    points = trendPointsOf(read.groups, opts?.tz);
  }
  return monthlyPossible ? points : trendMemo.set(memoKey, runKey, points);
}

/** How far the trend widens its run window looking for ten displayable points. */
const TREND_RUN_WINDOW_MAX = 80;

/** The per-run points of a measure's trend: completed runs only, one point per calendar day
 *  (the day's latest run), newest first, capped at 10 (Java parity). */
function trendPointsOf(groups: RunGroup[], tz?: string): ProgramTrendPoint[] {
  const n = (os: OutcomeWithRun[], s: string) => os.filter((o) => o.status === s).length;
  // Completed runs (COMPLETED or PARTIAL_FAILURE per isCompletedRun) are included as trend points
  // so the headline rate and "from previous" compare like with like; FAILED/QUEUED runs are not.
  const completed = groups.filter((g) => isCompletedRun(g.runStatus));

  // Collapse to at most one point per calendar day in the requested timezone (default UTC),
  // keeping the last (latest runStartedAt by epoch ms) completed run of that day.
  const dtf = createDayFormatter(tz);
  const latestByDay = new Map<string, { group: RunGroup; epochMs: number }>();
  for (const g of completed) {
    const epochMs = Date.parse(g.runStartedAt);
    const dayKey = dtf.format(epochMs);
    const existing = latestByDay.get(dayKey);
    if (!existing || epochMs > existing.epochMs) {
      latestByDay.set(dayKey, { group: g, epochMs });
    }
  }

  return [...latestByDay.values()]
    .map(({ group: { runId, runStartedAt, rows } }): ProgramTrendPoint => {
      const total = rows.length;
      const compliant = n(rows, "COMPLIANT");
      const dueSoon = n(rows, "DUE_SOON");
      const overdue = n(rows, "OVERDUE");
      // The SAME basis as the headline the trend sits under (ADR-079). Until the flag was a column
      // this point could not be corrected at all — the membership lived in evidence, and reading ten
      // runs' evidence per measure is the cost the read-path work exists to avoid — so a corrected
      // headline beside an uncorrected trend produced a fabricated delta: CMS125 at 72.1% above a
      // sparkline ending 18.0% for the SAME run, rendered as a +54-point improvement.
      const notInPopulation = rows.reduce((acc, o) => acc + (o.outOfPopulation === true && o.status === "MISSING_DATA" ? 1 : 0), 0);
      const missingData = n(rows, "MISSING_DATA") - notInPopulation;
      const excluded = n(rows, "EXCLUDED");
      const denominator = total - excluded - notInPopulation;
      return {
        runId,
        startedAt: runStartedAt,
        complianceRate: complianceRateOf({ compliant, dueSoon, overdue, missingData, excluded }),
        totalEvaluated: total,
        denominator,
        compliant,
        dueSoon,
        overdue,
        missingData,
        notInPopulation,
        excluded,
      };
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, 10);
}

/** Overdue concentration (site/role) + flagged-reason mix for a measure's latest filtered run. */
export async function programTopDrivers(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
): Promise<TopDrivers> {
  const empty: TopDrivers = { bySite: [], byRole: [], byOutcomeReason: [] };
  const { winners, runKey } = await latestPopulationWinners(deps.outcomeStore, [measureId], measureFilter(filters));
  const memoKey = chartMemoKey(deps, measureId, filters);
  const cached = driversMemo.get(memoKey, runKey);
  if (cached) return cached;
  const { groups, directory, fellBack } = await runsWithOutcomes(deps, measureId, filters, 1, winners);
  // A fallback result is never memoized (see `fellBack`): its answer can move while the winners stay.
  const remember = (value: TopDrivers): TopDrivers => (fellBack ? value : driversMemo.set(memoKey, runKey, value));
  if (groups.length === 0) return remember(empty);
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

  // Out-of-population subjects are not flagged work: the logic ran and they are not the measure's
  // concern this period (ADR-078). Left in, they WERE the mix — 14,872 of CMS125's 16,254 "flagged"
  // rows — and the panel read as one giant Missing Data slice no one could act on. Same column the
  // overview's bucket counts, so the card and this panel cannot disagree (ADR-079).
  const FLAGGED = new Set(["OVERDUE", "MISSING_DATA", "DUE_SOON"]);
  const flagged = outcomes.filter((o) => FLAGGED.has(o.status) && !(o.outOfPopulation === true && o.status === "MISSING_DATA"));
  const totalFlagged = flagged.length;
  const reasonCounts = new Map<string, number>();
  for (const o of flagged) reasonCounts.set(o.status, (reasonCounts.get(o.status) ?? 0) + 1);
  const byOutcomeReason = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count, pct: totalFlagged === 0 ? 0 : Math.round((count / totalFlagged) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);

  return remember({ bySite, byRole, byOutcomeReason });
}

// ---- risk outlook (#107) ----------------------------------------------------
const DUE_SOON_BUFFER_DAYS = 30;
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
 * The part of the outlook the WINNING RUN determines, and therefore the part worth remembering.
 *
 * A terminal population run's outcome rows are immutable, so everything derived from them is stable
 * while the same run wins — which is what {@link RunKeyedMemo} checks. `today` and `horizonDays` are
 * deliberately NOT part of it: they are applied per request by {@link renderOutlook}, so a warmed
 * entry survives until the next run instead of expiring at UTC midnight, and two requests asking
 * for different horizons share one read.
 *
 * **One thing here is NOT run-determined, and it is shared with the siblings rather than new.** The
 * site names, and the subject names in the expirations, are resolved through the DIRECTORY when the
 * base is built. On a live-WebChart deployment that directory is mutable process state
 * (`replaceLiveDirectory`), so an ingest that names a previously-raw `wc|` subject — or makes one
 * resolvable at all, since visibility is a directory fact too — is not reflected until a new run
 * wins. Two reviewers raised it. It is left as it is, deliberately: `overviewMemo` memoizes the
 * `DirectorySnapshot` itself, and `driversMemo` and `sitesMemo` hold directory-derived site and role
 * strings, so resolving this one surface per request would make it disagree with the other three —
 * and the site buckets are aggregated BY site name, so un-freezing them means memoizing per-subject
 * rows and re-bucketing on every request, which is most of the work the memo exists to skip. It
 * self-heals on the next run. ADR-081 states it rather than claiming purity.
 */
interface OutlookSiteCounts {
  total: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  notInPopulation: number;
  excluded: number;
}

interface OutlookBase {
  sites: Array<{ site: string; counts: OutlookSiteCounts }>;
  /**
   * Every visible COMPLIANT subject whose evidence carries a recency date — the only rows an
   * upcoming expiration can be computed from. EMPTY for an officially routed winner, whose
   * `expressionResults` are named `official:<population>` and carry no recency define at all.
   */
  compliantExams: Array<{ subjectId: string; name: string; site: string; lastExam: string }>;
}

const EMPTY_OUTLOOK_BASE: OutlookBase = { sites: [], compliantExams: [] };

/** Whether an outcome's evidence is an officially routed measure's (the ADR-046 `official` block). */
const hasOfficialEvidence = (evidence: unknown): boolean =>
  (evidence as { official?: unknown } | null | undefined)?.official != null;

/**
 * `today` + `horizon` + the measure's window applied over a memoized {@link OutlookBase}. No I/O and
 * O(compliant subjects), which is why those two request-dependent quantities stay out of the key.
 */
function renderOutlook(
  measureName: string,
  base: OutlookBase,
  window: number,
  horizon: number,
  today: string,
): RiskOutlook {
  const threshold = Math.max(window - DUE_SOON_BUFFER_DAYS, 0);
  const upcomingBySite = new Map<string, number>();
  const upcomingExpirations: RiskOutlook["upcomingExpirations"] = [];
  for (const exam of base.compliantExams) {
    const daysSince = daysBetween(exam.lastExam, today);
    if (daysSince >= threshold) continue;
    const daysUntil = threshold - daysSince;
    if (daysUntil > horizon) continue;
    upcomingBySite.set(exam.site, (upcomingBySite.get(exam.site) ?? 0) + 1);
    upcomingExpirations.push({
      externalId: exam.subjectId,
      name: exam.name,
      site: exam.site,
      measureName,
      lastExamDate: exam.lastExam,
      complianceWindowDays: window,
      daysSinceLastExam: daysSince,
      daysUntilDueSoon: daysUntil,
      predictedDueSoonDate: addDays(exam.lastExam, threshold),
    });
  }
  upcomingExpirations.sort((a, b) => a.daysUntilDueSoon - b.daysUntilDueSoon || a.name.localeCompare(b.name));

  const siteComplianceRates = base.sites
    .map(({ site, counts: a }) => {
      const upcoming = upcomingBySite.get(site) ?? 0;
      return {
        site,
        // Every row the winning run evaluated at this site, unchanged — the rates beside it are the
        // ones that drop the subjects the measure does not describe.
        total: a.total,
        compliant: a.compliant,
        upcomingExpirations: upcoming,
        currentComplianceRate: complianceRateOf(a),
        predictedComplianceRate: complianceRateOf({
          compliant: Math.max(0, a.compliant - upcoming),
          dueSoon: a.dueSoon + Math.min(a.compliant, upcoming),
          overdue: a.overdue,
          missingData: a.missingData,
          excluded: a.excluded,
        }),
      };
    })
    .sort((a, b) => a.currentComplianceRate - b.currentComplianceRate);

  return {
    upcomingNonCompliantCount: upcomingExpirations.length,
    upcomingExpirations,
    // RETIRED (ADR-081), and the key is kept with an empty array so the page, the route contract and
    // the e2e suite are unchanged. A streak of three PERIODS cannot be read from the winning run: a
    // nightly deployment's newest N runs share one period for any N, so reaching three needs either
    // the measure's whole retained history — which is the 504 this function existed to cause — or new
    // per-period SQL the owner must approve and index. ADR-073 has meanwhile decided that per-subject
    // history is a retention WINDOW, so under the pilot's 400 days an annual measure holds at most
    // two periods and this list is empty there by construction. It returns when the aggregate
    // snapshot store grows a per-subject dimension, or behind an indexed per-period query, as its own
    // unit of work.
    repeatNonCompliers: [],
    siteComplianceRates,
  };
}

/**
 * Predictive risk outlook for a measure: who becomes DUE_SOON within the horizon, and per-site
 * current vs predicted compliance. Returns null for an unknown measure (→ 404).
 *
 * **Read-path perf, part 3 (2026-09-15).** This was the last roster-wide read model still scanning a
 * measure's whole retained history — `listOutcomesForMeasure`, with evidence, every run and every
 * period, about a million rows on the pilot and growing by 120,000 a night, which answered 504 cold
 * and 8.2 s warm. It now joins every other such read on the winning run (#547): the winner is
 * resolved from the runs table, its rows are read once, and what those rows determine is memoized
 * under their `runKey`.
 *
 * Three semantic changes travel with that, each of them shared with the surfaces that moved in #547:
 * (a) the site table and its counts describe the subjects the WINNING RUN evaluated, so a subject
 * present only in an older run drops out; (b) the winners walk excludes a run whose `triggered_by`
 * is NULL under `excludeScale`, where the old subject-prefix exclusion kept it; (c) the
 * repeat-non-complier streak is retired — see {@link renderOutlook}.
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
  const render = (base: OutlookBase): RiskOutlook => renderOutlook(measure.name, base, window, horizon, today);

  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  const { winners, runKey } = await latestPopulationWinners(deps.outcomeStore, [measureId], LATEST_FILTER);
  // A measure that has never run: answer without going through the snapshot, which for an empty
  // winners list would build a directory over zero rows and then memoize an empty answer.
  //
  // Both of those are harmless, and this branch is therefore a cheap short-circuit rather than a
  // correctness guard — said plainly because two plausible-sounding reasons for it are FALSE, and
  // each was disproved by mutating it rather than by reasoning:
  //   1. "An entry keyed by `runKeyOf([])` — the empty string — would never be evicted, so the first
  //      visit to a fresh measure would pin 'no outlook' forever." No: `RunKeyedMemo.get` compares
  //      the stored key with the `runKey` the CALLER presents from a fresh winners walk, so the entry
  //      stops matching the moment a run exists. Memoizing here fails no test, correctly.
  //   2. "It saves a row read." No: `readWinnersRows` already returns early on an empty winners list.
  // What it actually saves is one `directoryForRows` call and one memo slot per unrun measure. Keep
  // it or delete it; do not add a claim to it that a test cannot hold.
  if (winners.length === 0) return render(EMPTY_OUTLOOK_BASE);

  // The seam decides which subjects are visible at all, so it keys the memo beside the measure.
  const memoKey = `${measureId}|${webChartConfigured}`;
  const cached = outlookMemo.get(memoKey, runKey);
  if (cached) return render(cached);

  const snap = await latestPopulationSnapshot(deps.outcomeStore, [measureId], LATEST_FILTER, deps.webChartEnv, 1, {
    precomputed: winners,
    visible: (id, ctx) => subjectVisible(id, ctx.webChartConfigured) && ctx.profileMatch(id),
  });
  const visibleRows = snap.rows.filter(
    (row) => subjectVisible(row.subjectId, snap.webChartConfigured) && snap.profileMatch(row.subjectId),
  );

  // One run, so one row per subject — the run pipeline writes one outcome per
  // (subject, measure, period) and `perMeasure = 1` means one run and one period.
  //
  // There is NO database constraint saying so (`outcomes` has no UNIQUE on
  // `(run_id, subject_id, measure_id)`), and the lean `listOutcomesWithRun` projection carries
  // neither `evaluated_at` nor `id` and has no ORDER BY — so if a run ever DID hold two rows for one
  // subject, which of them lands here is whatever the store returned last. Reviewers split on this:
  // one called it a P1 regression (the old evidence-rich read was ordered, so its last-write-wins was
  // deterministic), the other noted it is what `programOverview` already does and that the two
  // surfaces would disagree anyway, because the overview COUNTS ROWS (`total: os.length`) where this
  // dedupes per subject. Both are right, and neither is fixable here: ordering this would mean
  // widening `OutcomeWithRun` for every caller and seven test row factories, and the real remedy is a
  // uniqueness constraint, which is owner schema. Recorded in ADR-081 as a stated assumption with an
  // owner question rather than silently assumed.
  const latestBySubject = new Map<string, OutcomeWithRun>();
  for (const row of visibleRows) latestBySubject.set(row.subjectId, row);

  const siteAcc = new Map<string, OutlookSiteCounts>();
  for (const row of latestBySubject.values()) {
    const site = snap.directory.employeeById(row.subjectId)?.site || "Unknown";
    const acc =
      siteAcc.get(site) ??
      siteAcc
        .set(site, { total: 0, compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, notInPopulation: 0, excluded: 0 })
        .get(site)!;
    acc.total++;
    if (row.status === "COMPLIANT") acc.compliant++;
    else if (row.status === "DUE_SOON") acc.dueSoon++;
    else if (row.status === "OVERDUE") acc.overdue++;
    // ADR-079: not a gap and not in the rate, on the same basis as every other surface. Unrecorded
    // (an un-backfilled row) counts as missing data, which is what this table reported before.
    else if (row.status === "MISSING_DATA") (row.outOfPopulation === true ? acc.notInPopulation++ : acc.missingData++);
    else if (row.status === "EXCLUDED") acc.excluded++;
  }

  const compliantSubjects = [...latestBySubject.values()].filter((row) => row.status === "COMPLIANT");
  const compliantExams: OutlookBase["compliantExams"] = [];
  // `snap.winners[0]`, never the precomputed winner: a visibility fallback REPLACES the winner and
  // reports the replacement, so reading the precomputed run would pair an older visible snapshot with
  // evidence from a newer invisible run. Empty when the winner held no row we can see.
  const evidenceRunId = snap.winners[0]?.runId ?? null;
  if (compliantSubjects.length > 0 && evidenceRunId) {
    // Whether the winner's outcomes carry a recency define is a fact about THOSE ROWS, not about
    // today's routing flag. Reading the flag instead would zero an authored winner's expirations in a
    // process restarted after an authored→official flip, and would serve the authored answer from a
    // warm process under an unchanged key. So peek ONE row of the run whose rows are being described:
    // an official outcome's evidence carries `official`, and the expirations are then empty without a
    // second read (the old code paged 20,000 blobs to find nothing).
    //
    // The peeked row is a COMPLIANT SUBJECT'S OWN row, not the run's first. Both reviewers caught the
    // first-row form: `listOutcomes` orders by `(evaluated_at, id)` ASC, an evaluation failure
    // REPLACES the evidence with `{ evaluationError, message }` (DATA_MODEL_CONTRACTS §5), and a
    // PARTIAL_FAILURE run satisfies `isCompletedRun` and can win — so an error row sorting first made
    // the peek learn nothing and fall through to the unpaged read of all 20,000 blobs, which is the
    // cost this peek exists to avoid. A COMPLIANT row cannot be an evaluation error, because an error
    // forces MISSING_DATA, so asking for one is exact rather than probabilistic. `subjectId` +
    // `measureId` + `limit: 1` is the single-row lookup the store documents as index-friendly.
    const peek = await deps.outcomeStore.listOutcomes(evidenceRunId, {
      measureId,
      subjectId: compliantSubjects[0]!.subjectId,
      limit: 1,
    });
    if (peek.length > 0 && !hasOfficialEvidence(peek[0]!.evidence)) {
      const evidenceBySubject = new Map<string, unknown>();
      for (const outcome of await deps.outcomeStore.listOutcomes(evidenceRunId, { measureId })) {
        evidenceBySubject.set(outcome.subjectId, outcome.evidence);
      }
      for (const row of compliantSubjects) {
        const lastExam = lastExamDateOf(evidenceBySubject.get(row.subjectId));
        if (!lastExam) continue;
        const emp = snap.directory.employeeById(row.subjectId);
        compliantExams.push({
          subjectId: row.subjectId,
          name: emp?.name ?? row.subjectId,
          site: emp?.site || "Unknown",
          lastExam,
        });
      }
    }
  }

  const base: OutlookBase = {
    sites: [...siteAcc.entries()].map(([site, counts]) => ({ site, counts })),
    compliantExams,
  };
  // A fallback result is never memoized (see `fellBack`): its answer can move while the winners stay.
  if (!snap.fellBack) outlookMemo.set(memoKey, runKey, base);
  return render(base);
}
