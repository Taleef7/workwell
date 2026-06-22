/**
 * Employee directory read models (#107) — TS port of EmployeeProfileService (getProfile + search).
 * Powers the case-detail employee drawer + the worklist employee search. Reads the synthetic
 * employee directory + the persisted outcomes/cases/audit ledger; no new data dependency.
 *
 * Fidelity (synthetic directory): the TS EmployeeProfile carries only externalId/name/role/site,
 * so supervisorName/startDate/fhirPatientId are null and `active` is true; SLA fields aren't modeled
 * on the case row, so slaDueDate/slaRemainingDays are null and slaBreached is false. The compliance
 * data (outcomes, open cases, audit timeline) is real.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { employeeById, EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { deriveWhyFlagged } from "../case/case-detail-read-model.ts";

export interface MeasureOutcomeSummary {
  measureVersionId: string;
  measureName: string;
  measureVersion: string;
  outcomeStatus: string;
  lastRunDate: string;
  daysSinceLastExam: number | null;
  daysUntilDue: number | null;
  openCaseId: string | null;
}
export interface OpenCaseSummary {
  caseId: string;
  measureName: string;
  outcomeStatus: string;
  priority: string;
  assignee: string | null;
  slaDueDate: string | null;
  slaRemainingDays: number | null;
  slaBreached: boolean;
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
  latestOutcome: string | null;
}

export interface EmployeeProfileDeps {
  outcomes: OutcomeStore;
  cases: CaseStore;
  events: CaseEventStore;
}

const measureVersionOf = (measureId: string): string => {
  const lib = MEASURES[measureId]?.library ?? "";
  const dash = lib.lastIndexOf("-");
  return dash >= 0 ? lib.slice(dash + 1) : "";
};
const measureNameOf = (measureId: string): string => MEASURES[measureId]?.name ?? measureId;

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

const OPEN_STATUSES = ["OPEN", "IN_PROGRESS"];

/** GET /api/employees/:externalId/profile — null when the employee is unknown (route → 404). */
export async function getEmployeeProfile(deps: EmployeeProfileDeps, externalId: string): Promise<EmployeeProfileResponse | null> {
  const emp = employeeById(externalId);
  if (!emp) return null;

  // One cases fetch for this employee: derive the open subset AND the full case-id set used by the
  // recent-activity timeline below (this previously called listCases twice — open, then all).
  const employeeCases = (await deps.cases.listCases({ limit: 100000, offset: 0 })).filter(
    (c) => c.employeeId === externalId,
  );
  const openCases = employeeCases.filter((c) => OPEN_STATUSES.includes((c.status ?? "").toUpperCase()));
  const openCaseByMeasure = new Map<string, string>();
  for (const c of openCases) openCaseByMeasure.set(c.measureId, c.id);

  // Latest outcome per measure (newest-first history, dedupe by measure).
  const history = await deps.outcomes.listOutcomesForEmployee(externalId, 100000);
  const seen = new Set<string>();
  const measureOutcomes: MeasureOutcomeSummary[] = [];
  for (const o of history) {
    if (seen.has(o.measureId)) continue;
    seen.add(o.measureId);
    const wf = deriveWhyFlagged(o.evidence, o.measureId, o.evaluationPeriod, o.status);
    const window = typeof wf.compliance_window_days === "number" ? wf.compliance_window_days : null;
    // daysSinceLastExam = actual recency; daysUntilDue = window − recency (negative ⇒ overdue).
    const daysSince = actualDaysSince(o.evidence);
    measureOutcomes.push({
      measureVersionId: o.measureId,
      measureName: measureNameOf(o.measureId),
      measureVersion: measureVersionOf(o.measureId),
      outcomeStatus: o.status,
      lastRunDate: o.evaluatedAt,
      daysSinceLastExam: daysSince,
      daysUntilDue: daysSince !== null && window !== null ? window - daysSince : null,
      openCaseId: openCaseByMeasure.get(o.measureId) ?? null,
    });
  }

  const openCaseSummaries: OpenCaseSummary[] = openCases
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({
      caseId: c.id,
      measureName: measureNameOf(c.measureId),
      outcomeStatus: c.currentOutcomeStatus,
      priority: c.priority,
      assignee: c.assignee,
      slaDueDate: null, // SLA not modeled on the TS case row
      slaRemainingDays: null,
      slaBreached: false,
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
    startDate: null,
    fhirPatientId: null,
    active: true,
    measureOutcomes,
    openCases: openCaseSummaries,
    recentAuditEvents,
  };
}

/** GET /api/employees/search?q=&limit= — name/externalId/role substring (min 2 chars), + latest outcome. */
export async function searchEmployees(deps: EmployeeProfileDeps, q: string, limit: number): Promise<EmployeeSearchResult[]> {
  if (!q || q.trim().length < 2) return [];
  const needle = q.trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const matches = EMPLOYEES.filter(
    (e) => e.name.toLowerCase().includes(needle) || e.externalId.toLowerCase().includes(needle) || e.role.toLowerCase().includes(needle),
  )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, safeLimit);

  return Promise.all(
    matches.map(async (e) => {
      const latest = (await deps.outcomes.listOutcomesForEmployee(e.externalId, 1))[0] ?? null;
      return { externalId: e.externalId, name: e.name, role: e.role, site: e.site, latestOutcome: latest?.status ?? null };
    }),
  );
}
