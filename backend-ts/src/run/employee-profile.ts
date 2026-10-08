/**
 * Employee directory read models (#107) — TS port of EmployeeProfileService (getProfile + search).
 * Powers the case-detail employee drawer + the worklist employee search. Reads the synthetic
 * employee directory + the persisted outcomes/cases/audit ledger; no new data dependency.
 *
 * Fidelity (synthetic directory): the TS EmployeeProfile carries only externalId/name/role/site,
 * so supervisorName/startDate/fhirPatientId are null and `active` is true; SLA fields aren't modeled
 * on the case row. SLA was removed entirely (#600) rather than reported as a null that reads as a
 * checked condition; see `case/case-read-models.ts` for why. The compliance
 * data (outcomes, open cases, audit timeline) is real.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { OutcomeRecord, OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { employeeById, employees, providerById } from "../config/deployment-profile.ts";
import { payerNameOf } from "../engine/synthetic/payer-display.ts";
import { DIRECTORY } from "../config/deployment-profile.ts";
import { directoryForRows } from "../engine/ingress/webchart/live-directory.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { measureVersionOf, scoringLogicOf, type ScoringLogic } from "../measure/measure-identity.ts";
import { caseLogicKey, scoringLogicForCases, type CaseOutcomeRef } from "../case/case-scoring-logic.ts";
import { deriveWhyFlagged } from "../case/case-detail-read-model.ts";
import { ACTIVE_CASE_STATUSES } from "../case/case-logic.ts";
import { deriveCell, type DisplayState } from "../compliance/roster-vocabulary.ts";
import { AVAILABLE_PANELS, RUNNABLE_PANELS } from "../compliance/panels.ts";
import { isCompletedRun, isPopulationRun } from "../program/rollup-shared.ts";
import { measureDisplayName } from "../measure/measure-name.ts";
import { isApplicable } from "../segment/segment-applicability.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";

export interface MeasureOutcomeSummary {
  measureId: string;
  measureVersionId: string;
  measureName: string;
  /** The winning row's scoring version (`measureVersionOf`, #769) — never "2.0.0" for a CMS-scored row. */
  measureVersion: string;
  /**
   * The logic that scored the winning row, from that row's evidence (#769): what the Measure Details row
   * and the summary bar name. Null for authored CQL or an errored row.
   */
  logic: ScoringLogic | null;
  /** The stored bucket. `displayStatus` is what to SHOW (#671). */
  outcomeStatus: string;
  /**
   * This outcome read the way the roster table reads an outcome (`deriveCell`), so an
   * out-of-population MISSING_DATA shows OUT_OF_POPULATION here too, not "missing data" (#671).
   * And the same ROW the table reads: the measure's winning population run. It used to be the newest
   * outcome from any run, so a single-patient rerun, or the nightly while it ran, gave the page's
   * summary one answer and its table another.
   */
  displayStatus: DisplayState;
  lastRunDate: string;
  daysSinceLastExam: number | null;
  daysUntilDue: number | null;
  openCaseId: string | null;
}
export interface OpenCaseSummary {
  caseId: string;
  measureId: string;
  measureName: string;
  outcomeStatus: string;
  /**
   * The logic behind `outcomeStatus` (#769): the case's CITED outcome, as on the work list and the case
   * page — which is not always the winning row (a one-patient rerun, or an older cycle's open case).
   */
  logic: ScoringLogic | null;
  priority: string;
  assignee: string | null;
  slaDueDate: string | null;
}
export interface AuditEventSummary {
  eventType: string;
  occurredAt: string;
  actor: string;
  measureName: string | null;
  summary: string;
}
export interface EmployeeProfileResponse {
  id: string;
  externalId: string;
  name: string;
  role: string;
  site: string;
  supervisorName: string | null;
  /**
   * The panel facts (MM-2): attributed PCP and primary payer, ids for matching and names for display.
   * Null where the directory records none — the occupational roster has no payer, and a live WebChart
   * directory has neither until Coverage extraction lands (#533).
   */
  providerId: string | null;
  providerName: string | null;
  payer: string | null;
  payerName: string | null;
  startDate: string | null;
  fhirPatientId: string | null;
  active: boolean;
  measureOutcomes: MeasureOutcomeSummary[];
  openCases: OpenCaseSummary[];
  recentAuditEvents: AuditEventSummary[];
}
export interface EmployeeSearchResult {
  externalId: string;
  name: string;
  role: string;
  site: string;
  /**
   * The subject's ACTIVE cases (open or in progress), every cycle: exactly the rows of the Open Cases
   * table on the page the result opens. The work list shows only each measure's current cycle, so the
   * two can differ while an older cycle's case is still open (before the first run of a new year, or
   * where the rollover close-out failed). It replaced `latestOutcome`, the newest outcome of ANY measure as the
   * stored bucket, which named one arbitrary measure, read an out-of-population patient as "MISSING
   * DATA", and could come from a measure the deployment no longer runs.
   */
  openGaps: number;
}

export interface EmployeeProfileDeps {
  outcomes: OutcomeStore;
  cases: CaseStore;
  events: CaseEventStore;
  webChartEnv?: DataSourceEnv;
  /** Configured segments: a measure the subject is in no enabled segment for reads NOT_APPLICABLE, as on the roster. */
  segments?: HydratedSegment[];
}

// The catalog carries a name for the official-only measures too; the authored registry alone left
// cms2/cms130/cms165/cms137 named by their ids (#671).
const measureNameOf = measureDisplayName;

interface ExprResult {
  define: string;
  result: unknown;
}
/**
 * The ACTUAL days since the last qualifying exam (the "Days Since …" define), gated on a real
 * recency date so MISSING_DATA (no exam) → null rather than the @1900 fallback distance. This is
 * the true recency — NOT `why_flagged.days_overdue` (= max(days − window, 0)), which would report
 * the overdue amount (e.g. 55 for a 420-days-ago exam) as if it were the recency.
 */
function actualDaysSince(evidence: unknown): number | null {
  const ers = (evidence as { expressionResults?: unknown } | null)?.expressionResults;
  const list: ExprResult[] = Array.isArray(ers) ? (ers as ExprResult[]) : [];
  const recent = list.find((r) => /^most recent .*date$/i.test(r.define));
  const hadExam = recent != null && recent.result != null;
  const daysDef = list.find((r) => /^days since/i.test(r.define));
  return hadExam && typeof daysDef?.result === "number" ? daysDef.result : null;
}

function humanReadable(eventType: string, actor: string | null, measureName: string | null): string {
  const who = actor && actor !== "system" ? actor : "System";
  const measure = measureName ? ` (${measureName})` : "";
  switch (eventType) {
    case "CASE_CREATED":
      return `${who} opened a case${measure}`;
    case "CASE_UPDATED":
      return `${who} updated the case${measure}`;
    case "CASE_RESOLVED":
      return `${who} resolved the case${measure}`;
    case "OUTREACH_SENT":
      return `${who} sent outreach${measure}`;
    case "CASE_SLA_BREACHED":
      return `Case SLA breached — priority escalated${measure}`;
    default:
      return eventType.replace(/_/g, " ").toLowerCase();
  }
}

/** GET /api/employees/:externalId/profile — null when the employee is unknown (route → 404). */
export async function getEmployeeProfile(deps: EmployeeProfileDeps, externalId: string): Promise<EmployeeProfileResponse | null> {
  // A configured wc profile rehydrates from persisted outcomes after a worker restart. Requiring at
  // least one row avoids fabricating profiles for arbitrary wc| ids; seam-off continues to resolve only
  // the static catalog.
  const webChartConfigured = isWebChartConfigured(deps.webChartEnv ?? {});
  const emp = employeeById(externalId) ?? (
    webChartConfigured && (await deps.outcomes.hasOutcomes(externalId))
      ? directoryForRows([{ subjectId: externalId }], true, deps.webChartEnv, DIRECTORY).employeeById(externalId)
      : null
  );
  if (!emp) return null;

  // One cases fetch for this employee: derive the open subset AND the full case-id set used by the
  // recent-activity timeline below (this previously called listCases twice — open, then all).
  // Filtered in SQL. This used to read every case in the tenant at `limit: 100000` and keep the ones
  // whose `employeeId` matched, so a page about ONE patient scaled with the whole practice's case
  // count. The limit stays high because a subject legitimately has one case per (measure, cycle) and
  // the timeline below wants all of them — but it now bounds this subject's history, not the tenant's.
  const employeeCases = await deps.cases.listCases({ employeeId: externalId, limit: 100000, offset: 0 });
  const openCases = employeeCases.filter((c) =>
    (ACTIVE_CASE_STATUSES as readonly string[]).includes((c.status ?? "").toUpperCase()),
  );
  const openCaseByMeasure = new Map<string, string>();
  for (const c of openCases) openCaseByMeasure.set(c.measureId, c.id);

  // One outcome per measure this deployment runs, from that measure's WINNING population run: the row
  // the roster table beside this section reads (`buildRoster`), so the two cannot disagree. A measure
  // outside the panels (an old authored one) read as one more measure the practice is scored on (#671).
  // A single-patient rerun is not a winner, and neither is a run still in flight.
  const measureIds = [...new Set(AVAILABLE_PANELS.flatMap((p) => RUNNABLE_PANELS[p]))];
  const winners = await deps.outcomes.listLatestPopulationRuns(measureIds, { excludeScale: true, excludeTrendHistory: true });
  const runByMeasure = new Map<string, string>();
  for (const w of winners) {
    if (!isPopulationRun(w.runScopeType) || !isCompletedRun(w.runStatus)) continue;
    if (!runByMeasure.has(w.measureId)) runByMeasure.set(w.measureId, w.runId);
  }
  const winningRows: OutcomeRecord[] = [];
  // The FIRST of this subject's rows in each winning run: the row a case citing that run names
  // (`outcomeForCase` reads the same order with `limit: 1`), kept so an open case citing the winning run
  // costs no second read for its logic below. Null records "read, and no row".
  const citedInWinningRun = new Map<string, { runId: string; row: OutcomeRecord | null }>();
  // In turn, not `Promise.all`: one page view must not take a connection per measure at once.
  for (const measureId of measureIds) {
    const runId = runByMeasure.get(measureId);
    if (!runId) continue;
    // Rows arrive evaluated_at ASC, so the last is the one the roster's derivation keeps.
    const rows = (await deps.outcomes.listOutcomes(runId, { measureId, subjectId: externalId }))
      .filter((r) => r.measureId === measureId && r.subjectId === externalId);
    citedInWinningRun.set(measureId, { runId, row: rows[0] ?? null });
    const row = rows.at(-1);
    if (row) winningRows.push(row);
  }

  const measureOutcomes: MeasureOutcomeSummary[] = [];
  for (const o of winningRows) {
    const wf = deriveWhyFlagged(o.evidence, o.measureId, o.evaluationPeriod, o.status);
    const window = typeof wf.compliance_window_days === "number" ? wf.compliance_window_days : null;
    // daysSinceLastExam = actual recency; daysUntilDue = window − recency (negative ⇒ overdue).
    const daysSince = actualDaysSince(o.evidence);
    measureOutcomes.push({
      measureId: o.measureId,
      measureVersionId: o.measureId,
      measureName: measureNameOf(o.measureId),
      // The row's own logic (#769). The authored library's version stood here, so a CMS-scored cms125
      // row read "2.0.0" on the patient page.
      measureVersion: measureVersionOf(o.measureId, o.evidence),
      logic: scoringLogicOf(o.evidence),
      outcomeStatus: o.status,
      // The roster's overlay, in the roster's order: out of cohort wins over any real outcome (E11.3).
      displayStatus: isApplicable(emp, o.measureId, deps.segments ?? [])
        ? deriveCell(o.status, o.evidence, o.measureId, o.evaluationPeriod).status
        : "NOT_APPLICABLE",
      lastRunDate: o.evaluatedAt,
      daysSinceLastExam: daysSince,
      daysUntilDue: daysSince !== null && window !== null ? window - daysSince : null,
      openCaseId: openCaseByMeasure.get(o.measureId) ?? null,
    });
  }

  // Each open case's logic from its CITED outcome (#769). A case citing the winning run reuses the row
  // read above; the rest (a one-patient rerun, an older cycle's open case) take one bounded read per
  // (run, measure) through the shared helper — never the winning row, which may be another logic's.
  const caseLogic = new Map<string, ScoringLogic | null>();
  const unread: CaseOutcomeRef[] = [];
  for (const c of openCases) {
    const winning = citedInWinningRun.get(c.measureId);
    if (winning && c.lastRunId && winning.runId === c.lastRunId) caseLogic.set(caseLogicKey(c), scoringLogicOf(winning.row?.evidence));
    else unread.push(c);
  }
  if (unread.length > 0) for (const [key, logic] of await scoringLogicForCases(deps.outcomes, unread)) caseLogic.set(key, logic);

  const openCaseSummaries: OpenCaseSummary[] = openCases
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({
      caseId: c.id,
      measureId: c.measureId,
      measureName: measureNameOf(c.measureId),
      outcomeStatus: c.currentOutcomeStatus,
      logic: caseLogic.get(caseLogicKey(c)) ?? null,
      priority: c.priority,
      assignee: c.assignee,
      slaDueDate: null, // SLA not modeled on the TS case row
    }));

  // Recent audit events for this employee's cases (last 20, newest-first) — reuse the single fetch
  // above (open + closed), so the timeline isn't limited to currently-open cases.
  const caseIds = new Set(employeeCases.map((c) => c.id));
  const caseMeasure = new Map<string, string>();
  for (const c of employeeCases) caseMeasure.set(c.id, c.measureId);

  // Bounded, case-scoped, newest-first SQL query (was: load the entire audit ledger and filter in JS).
  const ledger = await deps.events.auditEventsForCases([...caseIds], 20);
  const recentAuditEvents: AuditEventSummary[] = ledger
    .map((e) => {
      const measureName = e.refCaseId && caseMeasure.has(e.refCaseId) ? measureNameOf(caseMeasure.get(e.refCaseId)!) : null;
      return {
        eventType: e.eventType,
        occurredAt: e.occurredAt,
        actor: e.actor ?? "system",
        measureName,
        summary: humanReadable(e.eventType, e.actor, measureName),
      };
    });

  return {
    id: externalId, // synthetic directory has no internal UUID; externalId is the stable id
    externalId: emp.externalId,
    name: emp.name,
    role: emp.role,
    site: emp.site,
    supervisorName: null,
    providerId: emp.providerId ?? null,
    providerName: emp.providerId ? (providerById(emp.providerId)?.name ?? emp.providerId) : null,
    payer: emp.payer ?? null,
    payerName: emp.payer ? payerNameOf(emp.payer) : null,
    startDate: null,
    fhirPatientId: null,
    active: true,
    measureOutcomes,
    openCases: openCaseSummaries,
    recentAuditEvents,
  };
}

/** GET /api/employees/search?q=&limit= — name/externalId/role substring (min 2 chars), + open gaps. */
export async function searchEmployees(deps: EmployeeProfileDeps, q: string, limit: number): Promise<EmployeeSearchResult[]> {
  if (!q || q.trim().length < 2) return [];
  const needle = q.trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const matches = employees().filter(
    (e) => e.name.toLowerCase().includes(needle) || e.externalId.toLowerCase().includes(needle) || e.role.toLowerCase().includes(needle),
  )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, safeLimit);
  if (matches.length === 0) return [];

  // ONE read for every match (it was one outcome query per match). Unbounded by design: up to 50
  // subjects with one open case per (measure, cycle) each, and a capped read would undercount.
  const open = await deps.cases.listCases({
    employeeIds: matches.map((e) => e.externalId),
    statuses: [...ACTIVE_CASE_STATUSES],
    limit: 100000,
    offset: 0,
  });
  const openBySubject = new Map<string, number>();
  for (const c of open) openBySubject.set(c.employeeId, (openBySubject.get(c.employeeId) ?? 0) + 1);

  return matches.map((e) => ({
    externalId: e.externalId,
    name: e.name,
    role: e.role,
    site: e.site,
    openGaps: openBySubject.get(e.externalId) ?? 0,
  }));
}
