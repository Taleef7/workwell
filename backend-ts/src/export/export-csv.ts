/**
 * CSV export builders (#108 exports) — runs / outcomes / cases / audit, matching the column
 * contracts in docs/DATA_MODEL.md §6. Read from the existing stores + directories; no new data.
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { CaseStore, CaseQuery } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { toRunSummary } from "../run/read-models.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { toCsv } from "./csv.ts";

const measureName = (measureId: string) => MEASURES[measureId]?.name ?? measureId;
const measureVersion = (measureId: string) => {
  const lib = MEASURES[measureId]?.library ?? "";
  const dash = lib.lastIndexOf("-");
  return dash >= 0 ? lib.slice(dash + 1) : "-";
};

// ---- runs (DATA_MODEL §6.1) --------------------------------------------------
const RUN_HEADERS = [
  "runId", "measureName", "measureVersion", "scopeType", "triggerType", "status", "startedAt", "completedAt",
  "durationMs", "totalEvaluated", "compliant", "dueSoon", "overdue", "missingData", "excluded", "passRate", "dataFreshAsOf",
] as const;

export async function runsCsv(runStore: RunStore, outcomeStore: OutcomeStore, limit = 200): Promise<string> {
  const runs = await runStore.listRuns(limit);
  const rows = await Promise.all(
    runs.map(async (run) => {
      const s = toRunSummary(run, await outcomeStore.listOutcomes(run.id));
      const count = (status: string) => s.outcomeCounts.find((c) => c.status === status)?.count ?? 0;
      return [
        s.runId, s.measureName, s.measureVersion, s.scopeType, s.triggerType, s.status, s.startedAt, s.completedAt,
        s.durationMs, s.totalEvaluated, s.compliantCount, count("DUE_SOON"), count("OVERDUE"), count("MISSING_DATA"),
        count("EXCLUDED"), s.passRate, s.dataFreshAsOf,
      ];
    }),
  );
  return toCsv(RUN_HEADERS, rows);
}

// ---- outcomes (DATA_MODEL §6.2) ----------------------------------------------
const OUTCOME_HEADERS = [
  "outcomeId", "runId", "employeeExternalId", "employeeName", "role", "site", "measureName", "measureVersion",
  "evaluationPeriod", "status", "lastExamDate", "complianceWindowDays", "daysOverdue", "roleEligible", "siteEligible",
  "waiverStatus", "evaluatedAt",
] as const;

interface ExprResult {
  define: string;
  result: unknown;
}
const exprResults = (evidence: unknown): ExprResult[] => {
  const er = (evidence as { expressionResults?: unknown } | null)?.expressionResults;
  return Array.isArray(er) ? (er as ExprResult[]) : [];
};

/** why_flagged fields derived from the CQL defines (same derivation as case detail). */
function whyFlagged(evidence: unknown, measureId: string) {
  const ers = exprResults(evidence);
  const window = MEASURE_BINDINGS[measureId]?.complianceWindowDays ?? 365;
  const recent = ers.find((r) => /^most recent .*date$/i.test(r.define));
  const hadExam = recent != null && recent.result != null;
  const daysDefine = ers.find((r) => /^days since/i.test(r.define));
  const days = hadExam && typeof daysDefine?.result === "number" ? daysDefine.result : null;
  const waiver = ers.find((r) => /waiver|exemption|exclusion/i.test(r.define));
  return {
    lastExamDate: hadExam && typeof recent!.result === "string" ? recent!.result.slice(0, 10) : null,
    complianceWindowDays: window,
    daysOverdue: days !== null ? Math.max(days - window, 0) : null,
    waiverStatus: typeof waiver?.result === "boolean" ? (waiver.result ? "active" : "none") : "none",
  };
}

export async function outcomesCsv(outcomeStore: OutcomeStore, runStore: RunStore, runId?: string): Promise<string> {
  // Java exportOutcomeCsv: an explicit runId, otherwise the LATEST run (not every run's
  // outcomes — that would mix historical duplicate employee rows). Export exactly one run.
  const resolvedRunId = runId ?? (await runStore.listRuns(1))[0]?.id;
  const records = resolvedRunId ? await outcomeStore.listOutcomes(resolvedRunId) : [];
  const out = records
    .slice()
    .sort((a, b) => a.subjectId.localeCompare(b.subjectId)) // Java ORDER BY e.external_id ASC
    .map((o) => {
      const emp = employeeById(o.subjectId);
      const wf = whyFlagged(o.evidence, o.measureId);
      return [
        o.id, o.runId, o.subjectId, emp?.name ?? o.subjectId, emp?.role ?? "—", emp?.site ?? "—",
        measureName(o.measureId), measureVersion(o.measureId), o.evaluationPeriod, o.status,
        wf.lastExamDate, wf.complianceWindowDays, wf.daysOverdue, true, true, wf.waiverStatus, o.evaluatedAt,
      ];
    });
  return toCsv(OUTCOME_HEADERS, out);
}

// ---- cases (DATA_MODEL §6.3) -------------------------------------------------
const CASE_HEADERS = [
  "caseId", "employeeExternalId", "employeeName", "role", "site", "measureName", "measureVersion", "evaluationPeriod",
  "status", "priority", "assignee", "currentOutcomeStatus", "nextAction", "lastRunId", "createdAt", "updatedAt",
  "closedAt", "latestOutreachDeliveryStatus",
] as const;

export interface CaseExportFilter extends CaseQuery {
  /** Explicit case ids (the worklist's bulk-export of a selected set) — comma list in the route. */
  caseIds?: string[];
  /** Employee site (resolved from the directory, not stored on the case). */
  site?: string;
}

export async function casesCsv(caseStore: CaseStore, eventStore: CaseEventStore, filter: CaseExportFilter): Promise<string> {
  let cases = await caseStore.listCases({ ...filter, limit: 100000 });
  // caseIds + site aren't SQL-filterable here (site lives in the directory), so apply them in-app.
  if (filter.caseIds?.length) {
    const wanted = new Set(filter.caseIds);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  if (filter.site) {
    const site = filter.site.toLowerCase();
    cases = cases.filter((c) => (employeeById(c.employeeId)?.site ?? "").toLowerCase() === site);
  }
  const rows = await Promise.all(
    cases.map(async (c) => {
      const emp = employeeById(c.employeeId);
      const latest = await eventStore.latestOutreachDeliveryStatus(c.id);
      return [
        c.id, c.employeeId, emp?.name ?? c.employeeId, emp?.role ?? "—", emp?.site ?? "—",
        measureName(c.measureId), measureVersion(c.measureId), c.evaluationPeriod, c.status, c.priority, c.assignee,
        c.currentOutcomeStatus, c.nextAction, c.lastRunId, c.createdAt, c.updatedAt, c.closedAt, latest,
      ];
    }),
  );
  return toCsv(CASE_HEADERS, rows);
}

// ---- audit (Java AuditExportService header) ---------------------------------
const AUDIT_HEADERS = ["timestamp", "eventType", "caseId", "runId", "measureName", "employeeId", "actor", "detail"] as const;

export async function auditCsv(eventStore: CaseEventStore, caseStore: CaseStore): Promise<string> {
  const events = await eventStore.listAuditEvents();
  // Java derives the employee via the referenced case (COALESCE(case.employee_id, outcome.employee_id)).
  // Case audit payloads (assign/escalate/outreach) don't carry subjectId, so resolve it from the case.
  const caseEmployee = new Map<string, string>();
  for (const id of new Set(events.map((e) => e.refCaseId).filter((x): x is string => !!x))) {
    const c = await caseStore.getCase(id);
    if (c) caseEmployee.set(id, c.employeeId);
  }
  const rows = events.map((e) => {
    const employeeId =
      (e.payload.subjectId as string | undefined) ??
      (e.payload.employeeId as string | undefined) ??
      (e.refCaseId ? caseEmployee.get(e.refCaseId) : undefined) ??
      "";
    const name = e.refMeasureVersionId ? measureName(e.refMeasureVersionId.replace(/-v[\d.]+$/, "")) : "";
    return [e.occurredAt, e.eventType, e.refCaseId, e.refRunId, name, employeeId, e.actor, JSON.stringify(e.payload)];
  });
  return toCsv(AUDIT_HEADERS, rows);
}
