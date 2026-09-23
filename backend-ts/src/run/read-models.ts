/**
 * Run read models (#107 strangler — runs module) — the `/api/runs` list + detail
 * shapes the unchanged frontend consumes (`RunListItem`, `RunSummary`, `RunLogEntry`).
 *
 * Computed from the floor `runs` + `outcomes` rows + the measure registry, matching
 * the Java RunPersistenceService read model exactly:
 *   - passRate = compliant * 100 / totalEvaluated   (percentage, 0 when none)
 *   - nonCompliant = DUE_SOON | OVERDUE | MISSING_DATA  (EXCLUDED is neither)
 *   - dataFreshAsOf = MAX(evaluated_at); dataFreshnessMinutes = -1 when no outcomes
 *   - measureName/Version: the run's own scope — the measure's name for a MEASURE/CASE run, the site
 *     or subject for a SITE/EMPLOYEE run, "All Programs" only for an ALL_PROGRAMS run (#668)
 *
 * Note: `totalCases` is supplied by the caller (COUNT of cases with last_run_id = runId,
 * matching Java); it defaults to 0 for callers that don't compute it. `triggerType` is
 * "MANUAL" — the floor only holds manually-created runs so far.
 */
import type { RunRecord, RunLogRow } from "../stores/run-store.ts";
import { retentionDaysFromEnv } from "./outcome-compaction.ts";
import type { OutcomeRecord, OutcomeStatusCount } from "../stores/outcome-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { DEPLOYMENT_PROFILE, employeeById, profileSubjectMatcher, subjectNoun } from "../config/deployment-profile.ts";
import { measureDisplayName } from "../measure/measure-name.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";

export interface RunListItem {
  runId: string;
  /** What the run covered, in words: a measure's name, `Site: …`, `Patient: …`, or "All Programs". */
  measureName: string;
  /** The measure a MEASURE/CASE run evaluated; null for runs over every measure (#644, #668). */
  measureId: string | null;
  status: string;
  scopeType: string;
  triggerType: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  totalEvaluated: number;
  compliantCount: number;
  nonCompliantCount: number;
}

export interface RunSummary extends RunListItem {
  measureVersion: string;
  totalCases: number;
  passRate: number;
  /**
   * Of this run's MISSING_DATA rows, how many were subjects the measure's logic put OUTSIDE its
   * population (ADR-079). `outcomeCounts` still folds them into MISSING_DATA — that is the persisted
   * status and the histogram is a statement about persisted rows — so this is the number that
   * explains why the dashboard's denominator is smaller than `totalEvaluated`. 0 on a run that
   * predates the column, and on every authored measure.
   */
  notInPopulation: number;
  outcomeCounts: Array<{ status: string; count: number }>;
  dataFreshAsOf: string | null;
  dataFreshnessMinutes: number;
  /**
   * Set when this run predates the outcome-retention window (ADR-073), so its per-subject rows may
   * have been compacted and the counts below describe what SURVIVES rather than what the run found.
   * `null` on every deployment with retention off, which is every deployment but the pilot.
   */
  retentionNotice: string | null;
}

export interface RunLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

/** Per-employee outcome row for the run detail grid (Java RunOutcomeRow). */
export interface RunOutcomeRow {
  employeeName: string;
  employeeExternalId: string;
  role: string;
  site: string;
  /** The stored status. */
  outcomeStatus: string;
  /**
   * What to SHOW: a MISSING_DATA row the measure's logic put outside its population reads
   * OUT_OF_POPULATION (ADR-079). The same column test as the summary's `notInPopulation`, so the
   * grid and the counts above it agree (#668).
   */
  displayStatus: string;
  daysSinceExam: string | null;
  waiverStatus: string | null;
  caseId: string | null;
}

const NON_COMPLIANT = new Set(["DUE_SOON", "OVERDUE", "MISSING_DATA"]);

const SUBJECT_SINGULAR = subjectNoun(DEPLOYMENT_PROFILE).singular;
const SUBJECT_LABEL = SUBJECT_SINGULAR.charAt(0).toUpperCase() + SUBJECT_SINGULAR.slice(1);

/** The measure a MEASURE/CASE run evaluated, from the stored scope (the manual path writes both). */
function runMeasureId(run: Pick<RunRecord, "scopeType" | "scopeId" | "requestedScope">): string | null {
  if (run.scopeType !== "MEASURE" && run.scopeType !== "CASE") return null;
  const requested = run.requestedScope?.measureId;
  return run.scopeId ?? (typeof requested === "string" ? requested : null);
}

/**
 * What the run covered, as a title. It used to look the name up in the AUTHORED registry only, so a
 * run of an official-only measure (cms2, cms130, cms165, cms137 on Maui) and every SITE/patient run
 * were all titled "All Programs" (#668). The labels mirror `resolveScope`'s in `run-pipeline.ts`.
 */
function measureLabel(run: Pick<RunRecord, "scopeType" | "scopeId" | "site" | "requestedScope">): { name: string; version: string } {
  const measureId = runMeasureId(run);
  if (measureId) {
    const authored = MEASURES[measureId];
    const dash = authored ? authored.library.lastIndexOf("-") : -1;
    const version = authored
      ? (dash >= 0 ? authored.library.slice(dash + 1) : "")
      : (MEASURE_CATALOG.find((m) => m.id === measureId)?.version ?? "");
    return { name: measureDisplayName(measureId), version };
  }
  if (run.scopeType === "SITE" && run.site) return { name: `Site: ${run.site}`, version: "" };
  const subject = run.requestedScope?.employeeExternalId;
  if (run.scopeType === "EMPLOYEE" && typeof subject === "string") return { name: `${SUBJECT_LABEL}: ${subject}`, version: "" };
  return { name: "All Programs", version: "" };
}

function tally(outcomes: OutcomeRecord[]) {
  let compliant = 0;
  let nonCompliant = 0;
  let notInPopulation = 0;
  const byStatus = new Map<string, number>();
  let freshAsOf: string | null = null;
  for (const o of outcomes) {
    if (o.outOfPopulation === true && o.status === "MISSING_DATA") notInPopulation++;
    byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    if (o.status === "COMPLIANT") compliant++;
    else if (NON_COMPLIANT.has(o.status)) nonCompliant++;
    if (freshAsOf === null || o.evaluatedAt > freshAsOf) freshAsOf = o.evaluatedAt;
  }
  return { total: outcomes.length, compliant, nonCompliant, notInPopulation, byStatus, freshAsOf };
}

type Tally = { total: number; compliant: number; nonCompliant: number; notInPopulation: number; byStatus: Map<string, number>; freshAsOf: string | null };

/** Same tally as `tally(outcomes)`, but from a bounded `GROUP BY status` (+ MAX evaluated_at) instead
 *  of the per-subject rows — so the run list/summary never load the 120k rows of a seed:scale run. */
function tallyFromCounts(counts: OutcomeStatusCount[]): Tally {
  let total = 0;
  let compliant = 0;
  let nonCompliant = 0;
  let notInPopulation = 0;
  const byStatus = new Map<string, number>();
  let freshAsOf: string | null = null;
  for (const c of counts) {
    total += c.count;
    // The group key carries the flag since ADR-079; `byStatus` still folds both halves together, so
    // every existing consumer of the histogram sees exactly the counts it saw before.
    if (c.outOfPopulation === true && c.status === "MISSING_DATA") notInPopulation += c.count;
    byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + c.count);
    if (c.status === "COMPLIANT") compliant += c.count;
    else if (NON_COMPLIANT.has(c.status)) nonCompliant += c.count;
    if (c.latestEvaluatedAt && (freshAsOf === null || c.latestEvaluatedAt > freshAsOf)) freshAsOf = c.latestEvaluatedAt;
  }
  return { total, compliant, nonCompliant, notInPopulation, byStatus, freshAsOf };
}

function durationMs(run: RunRecord): number {
  if (!run.completedAt) return 0;
  return Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime());
}

/** Map a run's `triggered_by` to the list/filter `triggerType`. Real operator runs stay MANUAL;
 *  seed runs surface as SEED; scheduler-fired runs surface as SCHEDULED. */
export function triggerTypeOf(run: RunRecord): string {
  if (run.triggeredBy === "seed:trend-history" || run.triggeredBy === "seed:scale") return "SEED";
  if (run.triggeredBy === "scheduler") return "SCHEDULED";
  return "MANUAL";
}

function buildListItem(run: RunRecord, t: Tally): RunListItem {
  return {
    runId: run.id,
    measureName: measureLabel(run).name,
    measureId: runMeasureId(run),
    status: run.status,
    scopeType: run.scopeType,
    triggerType: triggerTypeOf(run),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: durationMs(run),
    totalEvaluated: t.total,
    compliantCount: t.compliant,
    nonCompliantCount: t.nonCompliant,
  };
}

/**
 * Whether a run is old enough for compaction to have touched it.
 *
 * **What this can and cannot say.** It reports that the run PREDATES the window, not how many rows
 * went — and it deliberately does not guess. The true evaluated count is not on the run row, and
 * putting it there is a schema change (owner-owned); deriving it from the surviving rows is circular,
 * since those are exactly what compaction removed. So the notice tells the operator that the numbers
 * on this page are a survivor count, which is the thing they would otherwise misread, and does not
 * invent a total it cannot know.
 *
 * A run inside the window, or any run at all on a deployment with retention off, gets `null`.
 */
export function retentionNoticeFor(
  run: Pick<RunRecord, "completedAt" | "startedAt">,
  opts: { retentionDays?: number | undefined; now?: number } = {},
): string | null {
  const { retentionDays } = opts;
  if (retentionDays === undefined || !Number.isInteger(retentionDays) || retentionDays <= 0) return null;
  const finished = Date.parse(run.completedAt ?? run.startedAt ?? "");
  if (!Number.isFinite(finished)) return null;
  const cutoff = (opts.now ?? Date.now()) - retentionDays * 86_400_000;
  if (finished >= cutoff) return null;
  return (
    `This run is older than the ${retentionDays}-day outcome retention window, so its per-subject ` +
    `results may have been compacted. The counts shown are the rows that survive: each subject's most ` +
    `recent result per measure and measurement period, and every result a case refers to — open or ` +
    `closed. The run's own totals are preserved in the quality history.`
  );
}

function buildSummary(run: RunRecord, t: Tally, totalCases: number, retentionDays?: number): RunSummary {
  const { name, version } = measureLabel(run);
  return {
    ...buildListItem(run, t),
    measureName: name,
    measureVersion: version,
    totalCases,
    // Deliberately compliant/totalEvaluated — an operational per-run statistic, not the CMS rate,
    // and so deliberately NOT narrowed by `notInPopulation` below: it answers "of the rows this run
    // wrote, how many came back compliant", which is a fact about the run. The rate that describes a
    // POPULATION is the programs overview's, and that one drops these subjects (ADR-079).
    passRate: t.total === 0 ? 0 : (t.compliant * 100) / t.total,
    // Reported so the gap between this run's rows and the dashboard's denominator has a number.
    notInPopulation: t.notInPopulation,
    outcomeCounts: [...t.byStatus.entries()].map(([status, count]) => ({ status, count })),
    dataFreshAsOf: t.freshAsOf,
    dataFreshnessMinutes: t.freshAsOf === null ? -1 : Math.floor((Date.now() - new Date(t.freshAsOf).getTime()) / 60000),
    retentionNotice: retentionNoticeFor(run, { retentionDays }),
  };
}

export function toRunListItem(run: RunRecord, outcomes: OutcomeRecord[]): RunListItem {
  return buildListItem(run, tally(outcomes));
}

/** Counts-based run list item — uses the bounded `countOutcomesByStatus` GROUP BY instead of loading
 *  every outcome row, so `/api/runs` scales to the 120k-row seed:scale runs without the 60s timeout. */
export function toRunListItemFromCounts(run: RunRecord, counts: OutcomeStatusCount[]): RunListItem {
  return buildListItem(run, tallyFromCounts(counts));
}

export function toRunSummary(run: RunRecord, outcomes: OutcomeRecord[], totalCases = 0, retentionDays?: number): RunSummary {
  return buildSummary(run, tally(outcomes), totalCases, retentionDays ?? retentionDaysFromEnv(process.env as Record<string, unknown>));
}

/** Counts-based run summary — same bounded-aggregation path as `toRunListItemFromCounts`. */
export function toRunSummaryFromCounts(run: RunRecord, counts: OutcomeStatusCount[], totalCases = 0, retentionDays?: number): RunSummary {
  return buildSummary(run, tallyFromCounts(counts), totalCases, retentionDays ?? retentionDaysFromEnv(process.env as Record<string, unknown>));
}

export function toRunLogEntries(logs: RunLogRow[]): RunLogEntry[] {
  return logs.map((l) => ({ timestamp: l.ts, level: l.level, message: l.message }));
}

// ---- per-employee outcome rows (#107) ---------------------------------------
interface ExprResult {
  define: string;
  result: unknown;
}
function expressionResults(evidence: unknown): ExprResult[] {
  const er = (evidence as { expressionResults?: unknown } | null)?.expressionResults;
  return Array.isArray(er) ? (er as ExprResult[]) : [];
}

/**
 * `days_since_exam` / `waiver_status` are derived from the CQL define results, matching
 * the Java why_flagged semantics: waiver_status is "active"/"none" off the measure's
 * waiver/exemption/exclusion define (CqlEvaluationService), and days-since is the recency
 * define's value. The exemption flag is named one of (consistent across runnable measures):
 * "Has Active Waiver" (OSHA audiogram), "Has Medical Exemption" (HAZWOPER/TB/other authored
 * wellness measures), "Has Documented Exclusion" (hypertension), "Has Valid Exemption" (flu),
 * "Has Exclusion" (CMS eCQM 125/122).
 */
const EXEMPTION_DEFINE = /waiver|exemption|exclusion|contraindication/i;

function daysSinceExam(evidence: unknown): string | null {
  const e = expressionResults(evidence).find((r) => /^days since/i.test(r.define));
  return e && e.result != null ? String(e.result) : null;
}
function waiverStatus(evidence: unknown): string | null {
  const e = expressionResults(evidence).find((r) => EXEMPTION_DEFINE.test(r.define));
  return e && typeof e.result === "boolean" ? (e.result ? "active" : "none") : null;
}

export function toRunOutcomeRow(outcome: OutcomeRecord, employeeLookup = employeeById): RunOutcomeRow {
  const emp = employeeLookup(outcome.subjectId); // null → degrade gracefully, never throw
  return {
    employeeName: emp?.name ?? outcome.subjectId,
    employeeExternalId: outcome.subjectId,
    role: emp?.role ?? "—",
    site: emp?.site ?? "—",
    outcomeStatus: outcome.status,
    displayStatus: outcome.status === "MISSING_DATA" && outcome.outOfPopulation === true ? "OUT_OF_POPULATION" : outcome.status,
    daysSinceExam: daysSinceExam(outcome.evidence),
    waiverStatus: waiverStatus(outcome.evidence),
    caseId: null, // cases module not ported yet (later #107 slice)
  };
}

/** Outcome rows for a run, sorted by employee name (matches the Java ORDER BY e.name). */
export function toRunOutcomeRows(outcomes: OutcomeRecord[], employeeLookup = employeeById): RunOutcomeRow[] {
  const profileMatch = profileSubjectMatcher(employeeLookup);
  return outcomes
    .filter((o) => profileMatch(o.subjectId))
    .map((o) => toRunOutcomeRow(o, employeeLookup))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

/** `/api/runs` list filters (the params the Runs page sends). All optional/AND-ed. */
export interface RunFilters {
  status?: string;
  scopeType?: string;
  triggerType?: string;
  site?: string;
  from?: string; // inclusive lower bound on the run's start day (YYYY-MM-DD…)
  to?: string; // inclusive upper bound
}

/** Day portion of an ISO/date string, for day-granular from/to comparison. */
const day = (s: string): string => s.slice(0, 10);

/**
 * The candidate set both run-history surfaces filter, read ONCE and identically (#601, review).
 *
 * The list route capped its read at 1,000 and the CSV was changed to read unbounded — which fixed the
 * export's own truncation and immediately recreated the parity defect from the other side: past 1,000
 * runs, a filter matching only older rows would export runs the screen had never shown. Two surfaces
 * answering one question have to scan one set, so they call this.
 *
 * Unbounded is the right side of that trade here, and the runs table is why: it grows by one nightly
 * plus the occasional manual run, where `cases` and `outcomes` grow per subject per measure. The cap
 * this replaces bounded nothing a deployment would notice and hid rows a filter had legitimately
 * selected.
 */
export async function runCandidates(
  runStore: { listRuns(limit: number): Promise<RunRecord[]> },
  filters: RunFilters,
): Promise<RunRecord[]> {
  return (await runStore.listRuns(Number.MAX_SAFE_INTEGER)).filter((r) => matchesRunFilters(r, filters));
}

export function matchesRunFilters(run: RunRecord, f: RunFilters): boolean {
  if (f.status && run.status !== f.status) return false;
  if (f.scopeType && run.scopeType !== f.scopeType) return false;
  if (f.triggerType && f.triggerType !== triggerTypeOf(run)) return false;
  if (f.site && run.site !== f.site) return false;
  if (f.from && day(run.startedAt) < day(f.from)) return false;
  if (f.to && day(run.startedAt) > day(f.to)) return false;
  return true;
}
