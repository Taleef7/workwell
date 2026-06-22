/**
 * Case detail read model (#107) — `GET /api/cases/:id` → `CaseDetail` for the case page.
 *
 * Built from the case row + the case's evidence (the outcome from its last run) + the
 * measure binding. why_flagged is derived from the CQL define results (the TS engine
 * stores expressionResults, not a why_flagged block), matching the Java field shape.
 *
 * The merged audit/case-action timeline and latestOutreachDeliveryStatus are passed
 * in by the caller (CaseEventStore); they default to []/null for read paths that don't
 * load them. closedReason/closedBy come from the case row (set by rerun-to-verify).
 */
import type { CaseRecord } from "../stores/case-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { type ImmunizationForecast } from "../engine/immunization/immunization-forecast.ts";

export interface CaseDetail {
  caseId: string;
  employeeId: string;
  employeeName: string;
  measureName: string;
  measureVersionId: string;
  measureVersion: string;
  evaluationPeriod: string;
  status: string;
  priority: string;
  assignee: string | null;
  nextAction: string;
  currentOutcomeStatus: string;
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedReason: string | null;
  closedBy: string | null;
  exclusionReason: string | null;
  waiverExpiresAt: string | null;
  waiverExpired: boolean;
  evidenceJson: Record<string, unknown>;
  outcomeStatus: string;
  outcomeSummary: string;
  outcomeEvaluatedAt: string;
  latestOutreachDeliveryStatus: string | null;
  timeline: unknown[];
  immunizationForecast?: ImmunizationForecast;
}

function outcomeSummaryFor(outcome: string): string {
  switch (outcome) {
    case "COMPLIANT":
      return "Measure outcome is compliant for the current window.";
    case "DUE_SOON":
      return "Measure outcome is due soon within the compliance window.";
    case "OVERDUE":
      return "Measure outcome is overdue and requires follow-up.";
    case "MISSING_DATA":
      return "Measure outcome could not be evaluated due to missing data.";
    case "EXCLUDED":
      return "Measure outcome is excluded due to documented exemption/waiver.";
    default:
      return "Unknown status.";
  }
}

function measureVersion(measureId: string): string {
  const lib = MEASURES[measureId]?.library ?? "";
  const dash = lib.lastIndexOf("-");
  return dash >= 0 ? lib.slice(dash + 1) : "";
}

export interface ExprResult {
  define: string;
  result: unknown;
}
export function expressionResults(evidence: unknown): ExprResult[] {
  const er = (evidence as { expressionResults?: unknown } | null)?.expressionResults;
  return Array.isArray(er) ? (er as ExprResult[]) : [];
}

/** Derive the why_flagged block (matching the Java shape) from the CQL define results. */
export function deriveWhyFlagged(evidence: unknown, measureId: string, evaluationPeriod: string, outcomeStatus: string) {
  const ers = expressionResults(evidence);
  const window = MEASURE_BINDINGS[measureId]?.complianceWindowDays ?? 365;
  const waiverDefine = ers.find((r) => /waiver|exemption|exclusion|contraindication/i.test(r.define));
  const waiverStatus = typeof waiverDefine?.result === "boolean" ? (waiverDefine.result ? "active" : "none") : "none";

  // The authoritative "had a real exam" signal is the "Most Recent … Date" recency define.
  // The "Days Since …" define coalesces that date with an @1900-01-01 fallback, so it is NEVER
  // null even when there was no exam — using it directly would report a bogus 1900-era
  // last_exam_date and tens of thousands of days_overdue for MISSING_DATA cases. Java keyed off
  // the source date being null (CqlEvaluationService#buildEvidenceJson) and left both fields null
  // on that path; we do the same by suppressing unless the recency date is present/non-null.
  const recentDefine = ers.find((r) => /^most recent .*date$/i.test(r.define));
  const hadExam = recentDefine != null && recentDefine.result != null;
  const daysDefine = ers.find((r) => /^days since/i.test(r.define));
  const days = hadExam && typeof daysDefine?.result === "number" ? daysDefine.result : null;

  let lastExamDate: string | null = null;
  if (hadExam && typeof recentDefine!.result === "string") {
    lastExamDate = recentDefine!.result.slice(0, 10);
  } else if (days !== null) {
    // Fallback: derive from days-since only when we know an exam happened.
    const d = new Date(`${evaluationPeriod.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      d.setUTCDate(d.getUTCDate() - days);
      lastExamDate = d.toISOString().slice(0, 10);
    }
  }
  return {
    last_exam_date: lastExamDate,
    compliance_window_days: window,
    days_overdue: days !== null ? Math.max(days - window, 0) : null,
    role_eligible: true,
    site_eligible: true,
    waiver_status: waiverStatus,
    outcome_status: outcomeStatus,
  };
}

/**
 * Build a `CaseDetail` response object from a case row, its latest outcome, and optional
 * contextual extras. The optional `immunizationForecast` advisory is attached ONLY for
 * `adult_immunization` cases (guard lives in the route); it is omitted (undefined) for all
 * other measures so the response key is absent on non-immunization cases.
 */
export function toCaseDetail(
  c: CaseRecord,
  outcome: OutcomeRecord | null,
  timeline: unknown[] = [],
  latestOutreachDeliveryStatus: string | null = null,
  immunizationForecast?: ImmunizationForecast,
): CaseDetail {
  const emp = employeeById(c.employeeId);
  const evidence = (outcome?.evidence as Record<string, unknown> | undefined) ?? {};
  return {
    caseId: c.id,
    employeeId: c.employeeId,
    employeeName: emp?.name ?? c.employeeId,
    measureName: MEASURES[c.measureId]?.name ?? c.measureId,
    measureVersionId: c.measureId,
    measureVersion: measureVersion(c.measureId),
    evaluationPeriod: c.evaluationPeriod,
    status: c.status,
    priority: c.priority,
    assignee: c.assignee,
    nextAction: c.nextAction ?? "",
    currentOutcomeStatus: c.currentOutcomeStatus,
    lastRunId: c.lastRunId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    closedAt: c.closedAt,
    closedReason: c.closedReason,
    closedBy: c.closedBy,
    exclusionReason: null,
    waiverExpiresAt: null,
    waiverExpired: false,
    evidenceJson: {
      ...evidence,
      why_flagged: deriveWhyFlagged(outcome?.evidence, c.measureId, c.evaluationPeriod, c.currentOutcomeStatus),
    },
    outcomeStatus: c.currentOutcomeStatus,
    outcomeSummary: outcomeSummaryFor(c.currentOutcomeStatus),
    outcomeEvaluatedAt: outcome?.evaluatedAt ?? c.updatedAt,
    latestOutreachDeliveryStatus,
    timeline,
    ...(immunizationForecast ? { immunizationForecast } : {}),
  };
}
