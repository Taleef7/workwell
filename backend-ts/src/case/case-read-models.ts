/**
 * Case read models (#107) — the worklist `CaseSummary` the frontend consumes,
 * resolving each case row to its employee (name/site, from the synthetic directory)
 * and measure (name/version, from the registry).
 *
 * SLA + waiver/exclusion fields are surfaced as neutral defaults for this slice
 * (slaRemainingDays/slaBreached/exclusionReason/waiver* land with the SLA + actions
 * slices); they are optional/nullable in the frontend type.
 */
import type { CaseRecord } from "../stores/case-store.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

export interface CaseSummary {
  caseId: string;
  employeeId: string;
  employeeName: string;
  site: string;
  measureVersionId: string;
  measureName: string;
  measureVersion: string;
  evaluationPeriod: string;
  status: string;
  priority: string;
  assignee: string | null;
  currentOutcomeStatus: string;
  lastRunId: string;
  exclusionReason: string | null;
  waiverExpiresAt: string | null;
  waiverExpired: boolean;
  updatedAt: string;
  slaRemainingDays: number | null;
  slaBreached: boolean;
  /**
   * Number of outreach sends recorded for this case (Java counts `outreach_records`;
   * the TS port derives it from the `OUTREACH_SENT` case_actions). The frontend
   * worklist-gap badge counts open cases with `outreachRecordCount === 0`.
   */
  outreachRecordCount: number;
}

function measureVersion(measureId: string): string {
  const lib = MEASURES[measureId]?.library ?? "";
  const dash = lib.lastIndexOf("-");
  return dash >= 0 ? lib.slice(dash + 1) : "";
}

export function toCaseSummary(c: CaseRecord, outreachRecordCount = 0): CaseSummary {
  const emp = employeeById(c.employeeId);
  return {
    caseId: c.id,
    employeeId: c.employeeId,
    employeeName: emp?.name ?? c.employeeId,
    site: emp?.site ?? "—",
    measureVersionId: c.measureId, // slug stands in for the canonical version UUID
    measureName: MEASURES[c.measureId]?.name ?? c.measureId,
    measureVersion: measureVersion(c.measureId),
    evaluationPeriod: c.evaluationPeriod,
    status: c.status,
    priority: c.priority,
    assignee: c.assignee,
    currentOutcomeStatus: c.currentOutcomeStatus,
    lastRunId: c.lastRunId,
    exclusionReason: null,
    waiverExpiresAt: null,
    waiverExpired: false,
    updatedAt: c.updatedAt,
    slaRemainingDays: null,
    slaBreached: false,
    outreachRecordCount,
  };
}
