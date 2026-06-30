/**
 * Run read models (#107 strangler — runs module) — the `/api/runs` list + detail
 * shapes the unchanged frontend consumes (`RunListItem`, `RunSummary`, `RunLogEntry`).
 *
 * Computed from the floor `runs` + `outcomes` rows + the measure registry, matching
 * the Java RunPersistenceService read model exactly:
 *   - passRate = compliant * 100 / totalEvaluated   (percentage, 0 when none)
 *   - nonCompliant = DUE_SOON | OVERDUE | MISSING_DATA  (EXCLUDED is neither)
 *   - dataFreshAsOf = MAX(evaluated_at); dataFreshnessMinutes = -1 when no outcomes
 *   - measureName/Version resolved from scopeId (null → "All Programs" / "")
 *
 * Note: `totalCases` is supplied by the caller (COUNT of cases with last_run_id = runId,
 * matching Java); it defaults to 0 for callers that don't compute it. `triggerType` is
 * "MANUAL" — the floor only holds manually-created runs so far.
 */
import type { RunRecord, RunLogRow } from "../stores/run-store.ts";
import type { OutcomeRecord, OutcomeStatusCount } from "../stores/outcome-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";

export interface RunListItem {
  runId: string;
  measureName: string;
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
  outcomeCounts: Array<{ status: string; count: number }>;
  dataFreshAsOf: string | null;
  dataFreshnessMinutes: number;
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
  outcomeStatus: string;
  daysSinceExam: string | null;
  waiverStatus: string | null;
  caseId: string | null;
}

const NON_COMPLIANT = new Set(["DUE_SOON", "OVERDUE", "MISSING_DATA"]);

function measureLabel(scopeId: string | null): { name: string; version: string } {
  const m = scopeId ? MEASURES[scopeId] : undefined;
  if (!m) return { name: "All Programs", version: "" };
  const dash = m.library.lastIndexOf("-");
  return { name: m.name, version: dash >= 0 ? m.library.slice(dash + 1) : "" };
}

function tally(outcomes: OutcomeRecord[]) {
  let compliant = 0;
  let nonCompliant = 0;
  const byStatus = new Map<string, number>();
  let freshAsOf: string | null = null;
  for (const o of outcomes) {
    byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    if (o.status === "COMPLIANT") compliant++;
    else if (NON_COMPLIANT.has(o.status)) nonCompliant++;
    if (freshAsOf === null || o.evaluatedAt > freshAsOf) freshAsOf = o.evaluatedAt;
  }
  return { total: outcomes.length, compliant, nonCompliant, byStatus, freshAsOf };
}

type Tally = { total: number; compliant: number; nonCompliant: number; byStatus: Map<string, number>; freshAsOf: string | null };

/** Same tally as `tally(outcomes)`, but from a bounded `GROUP BY status` (+ MAX evaluated_at) instead
 *  of the per-subject rows — so the run list/summary never load the 120k rows of a seed:scale run. */
function tallyFromCounts(counts: OutcomeStatusCount[]): Tally {
  let total = 0;
  let compliant = 0;
  let nonCompliant = 0;
  const byStatus = new Map<string, number>();
  let freshAsOf: string | null = null;
  for (const c of counts) {
    total += c.count;
    byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + c.count);
    if (c.status === "COMPLIANT") compliant += c.count;
    else if (NON_COMPLIANT.has(c.status)) nonCompliant += c.count;
    if (c.latestEvaluatedAt && (freshAsOf === null || c.latestEvaluatedAt > freshAsOf)) freshAsOf = c.latestEvaluatedAt;
  }
  return { total, compliant, nonCompliant, byStatus, freshAsOf };
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
    measureName: measureLabel(run.scopeId).name,
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

function buildSummary(run: RunRecord, t: Tally, totalCases: number): RunSummary {
  const { name, version } = measureLabel(run.scopeId);
  return {
    ...buildListItem(run, t),
    measureName: name,
    measureVersion: version,
    totalCases,
    passRate: t.total === 0 ? 0 : (t.compliant * 100) / t.total,
    outcomeCounts: [...t.byStatus.entries()].map(([status, count]) => ({ status, count })),
    dataFreshAsOf: t.freshAsOf,
    dataFreshnessMinutes: t.freshAsOf === null ? -1 : Math.floor((Date.now() - new Date(t.freshAsOf).getTime()) / 60000),
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

export function toRunSummary(run: RunRecord, outcomes: OutcomeRecord[], totalCases = 0): RunSummary {
  return buildSummary(run, tally(outcomes), totalCases);
}

/** Counts-based run summary — same bounded-aggregation path as `toRunListItemFromCounts`. */
export function toRunSummaryFromCounts(run: RunRecord, counts: OutcomeStatusCount[], totalCases = 0): RunSummary {
  return buildSummary(run, tallyFromCounts(counts), totalCases);
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
 * "Has Active Waiver" (OSHA audiogram), "Has Medical Exemption" (HAZWOPER/TB/HEDIS),
 * "Has Valid Exemption" (flu), "Has Exclusion" (CMS eCQM 125/122).
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

export function toRunOutcomeRow(outcome: OutcomeRecord): RunOutcomeRow {
  const emp = employeeById(outcome.subjectId); // null → degrade gracefully, never throw
  return {
    employeeName: emp?.name ?? outcome.subjectId,
    employeeExternalId: outcome.subjectId,
    role: emp?.role ?? "—",
    site: emp?.site ?? "—",
    outcomeStatus: outcome.status,
    daysSinceExam: daysSinceExam(outcome.evidence),
    waiverStatus: waiverStatus(outcome.evidence),
    caseId: null, // cases module not ported yet (later #107 slice)
  };
}

/** Outcome rows for a run, sorted by employee name (matches the Java ORDER BY e.name). */
export function toRunOutcomeRows(outcomes: OutcomeRecord[]): RunOutcomeRow[] {
  return outcomes.map(toRunOutcomeRow).sort((a, b) => a.employeeName.localeCompare(b.employeeName));
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

export function matchesRunFilters(run: RunRecord, f: RunFilters): boolean {
  if (f.status && run.status !== f.status) return false;
  if (f.scopeType && run.scopeType !== f.scopeType) return false;
  if (f.triggerType && f.triggerType !== triggerTypeOf(run)) return false;
  if (f.site && run.site !== f.site) return false;
  if (f.from && day(run.startedAt) < day(f.from)) return false;
  if (f.to && day(run.startedAt) > day(f.to)) return false;
  return true;
}
