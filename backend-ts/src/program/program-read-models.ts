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
import type { OutcomeStore, OutcomeRecord } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";

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
}

export interface ProgramDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  caseStore: CaseStore;
  employees?: readonly EmployeeProfile[];
}

/** Per-run trend point (Java ProgramTrendPoint). The chart reads runId/startedAt/complianceRate/totalEvaluated. */
export interface ProgramTrendPoint {
  runId: string;
  startedAt: string;
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

const day = (s: string): string => s.slice(0, 10);
const eq = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/** Distinct employee sites, ascending — the global site filter's options. */
export function listSites(employees: readonly EmployeeProfile[] = EMPLOYEES): string[] {
  return [...new Set(employees.map((e) => e.site).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b));
}

export async function programOverview(deps: ProgramDeps, filters: ProgramFilters): Promise<ProgramSummary[]> {
  const site = filters.site?.trim() || null;
  const from = filters.from?.trim() || null;
  const to = filters.to?.trim() || null;
  const siteOf = (subjectId: string): string | null => employeeById(subjectId)?.site ?? null;
  const inPeriod = (iso: string): boolean => (!from || day(iso) >= day(from)) && (!to || day(iso) <= day(to));
  const siteMatch = (subjectId: string): boolean => !site || eq(siteOf(subjectId), site);

  // Latest-run-per-measure needs run timestamps + that run's outcomes (filtered by site).
  const runs = (await deps.runStore.listRuns(100000)).filter((r) => inPeriod(r.startedAt));
  const outcomesByRun = new Map<string, OutcomeRecord[]>();
  await Promise.all(runs.map(async (r) => outcomesByRun.set(r.id, await deps.outcomeStore.listOutcomes(r.id))));
  const cases = await deps.caseStore.listCases({ limit: 100000 });

  const active = MEASURE_CATALOG.filter((m) => m.status === "Active");
  const summaries = active.map((m): ProgramSummary => {
    // The latest run (by startedAt) carrying site-filtered outcomes for this measure.
    let best: { run: (typeof runs)[number]; outcomes: OutcomeRecord[] } | null = null;
    for (const r of runs) {
      const os = (outcomesByRun.get(r.id) ?? []).filter((o) => o.measureId === m.id && siteMatch(o.subjectId));
      if (os.length === 0) continue;
      if (!best || r.startedAt > best.run.startedAt) best = { run: r, outcomes: os };
    }
    const os = best?.outcomes ?? [];
    const n = (status: string) => os.filter((o) => o.status === status).length;
    const total = os.length;
    const compliant = n("COMPLIANT");
    const complianceRate = total === 0 ? 0 : Math.round((compliant / total) * 1000) / 10;
    const openCaseCount = cases.filter(
      (c) => c.measureId === m.id && c.status === "OPEN" && siteMatch(c.employeeId) && inPeriod(c.createdAt),
    ).length;
    return {
      measureId: m.id,
      measureName: m.name,
      policyRef: m.policyRef,
      version: m.version,
      latestRunId: best?.run.id ?? null,
      latestRunAt: best?.run.startedAt ?? null,
      totalEvaluated: total,
      compliant,
      dueSoon: n("DUE_SOON"),
      overdue: n("OVERDUE"),
      missingData: n("MISSING_DATA"),
      excluded: n("EXCLUDED"),
      complianceRate,
      openCaseCount,
    };
  });
  return summaries.sort((a, b) => a.measureName.localeCompare(b.measureName));
}

/** Filters bundled into predicates over outcomes (resolving employee site from the directory). */
function predicates(filters: ProgramFilters) {
  const site = filters.site?.trim() || null;
  const from = filters.from?.trim() || null;
  const to = filters.to?.trim() || null;
  const inPeriod = (iso: string) => (!from || day(iso) >= day(from)) && (!to || day(iso) <= day(to));
  const siteMatch = (subjectId: string) => !site || eq(employeeById(subjectId)?.site ?? null, site);
  return { inPeriod, siteMatch };
}

/** Period-filtered runs, each with its site-filtered outcomes for the measure (only runs with ≥1). */
async function runsWithOutcomes(deps: ProgramDeps, measureId: string, filters: ProgramFilters) {
  const { inPeriod, siteMatch } = predicates(filters);
  const runs = (await deps.runStore.listRuns(100000)).filter((r) => inPeriod(r.startedAt));
  const pairs = await Promise.all(
    runs.map(async (run) => {
      const outcomes = (await deps.outcomeStore.listOutcomes(run.id)).filter(
        (o) => o.measureId === measureId && siteMatch(o.subjectId),
      );
      return { run, outcomes };
    }),
  );
  return pairs.filter((p) => p.outcomes.length > 0);
}

const round1 = (compliant: number, total: number) => (total === 0 ? 0 : Math.round((compliant / total) * 1000) / 10);

/** Per-run compliance trend for a measure — outcome-based, newest-first, capped at 10 (Java parity). */
export async function programTrend(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
): Promise<ProgramTrendPoint[]> {
  // NOTE: Java unions a `run_based` branch for aggregate-only seeded runs; the TS floor `runs`
  // table has no compliant/total columns, so every TS run with data has outcomes — the
  // outcome-based branch is complete here.
  const pairs = await runsWithOutcomes(deps, measureId, filters);
  const n = (os: OutcomeRecord[], s: string) => os.filter((o) => o.status === s).length;
  return pairs
    .map(({ run, outcomes }): ProgramTrendPoint => {
      const total = outcomes.length;
      const compliant = n(outcomes, "COMPLIANT");
      return {
        runId: run.id,
        startedAt: run.startedAt,
        complianceRate: round1(compliant, total),
        totalEvaluated: total,
        compliant,
        dueSoon: n(outcomes, "DUE_SOON"),
        overdue: n(outcomes, "OVERDUE"),
        missingData: n(outcomes, "MISSING_DATA"),
        excluded: n(outcomes, "EXCLUDED"),
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
  const pairs = await runsWithOutcomes(deps, measureId, filters);
  if (pairs.length === 0) return empty;
  // Latest filtered run with outcomes for this measure.
  const latest = pairs.reduce((a, b) => (b.run.startedAt > a.run.startedAt ? b : a));
  const outcomes = latest.outcomes;

  const overdue = outcomes.filter((o) => o.status === "OVERDUE");
  const tally = (key: (subjectId: string) => string) => {
    const counts = new Map<string, number>();
    for (const o of overdue) {
      const k = key(o.subjectId);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };
  const siteCounts = tally((id) => employeeById(id)?.site ?? "");
  const roleCounts = tally((id) => employeeById(id)?.role ?? "");

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
