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
import { employeeById, providerById } from "../config/deployment-profile.ts";
import { payerNameOf } from "../engine/synthetic/payer-display.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

export interface CaseSummary {
  caseId: string;
  employeeId: string;
  employeeName: string;
  site: string;
  /**
   * The subject's attributed PCP and primary payer — the two panel facts MM-2's work lists group and
   * filter by, resolved from the directory here rather than fetched again per row by every caller.
   *
   * `providerName`/`payerName` are DISPLAY, `providerId`/`payer` are what the filters match on; both
   * travel together so a list can render a name without a second lookup that could disagree with it.
   * Null where the directory records none: the occupational roster has no payer, and a live WebChart
   * directory has neither until Coverage extraction lands (#533).
   */
  providerId: string | null;
  providerName: string | null;
  payer: string | null;
  payerName: string | null;
  measureId: string;
  measureVersionId: string;
  measureName: string;
  measureVersion: string;
  evaluationPeriod: string;
  status: string;
  priority: string;
  assignee: string | null;
  currentOutcomeStatus: string;
  /**
   * The instruction on the case — the wording table's line, or an operator's own words where they
   * wrote one (`next_action_source`, ADR-076 d2). Additive: it was already on the case record and the
   * CSV, and the patient work list renders it per gap so a caller knows what to do without opening
   * each case.
   */
  nextAction: string | null;
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

export function toCaseSummary(
  c: CaseRecord,
  outreachRecordCount = 0,
  employeeLookup: typeof employeeById = employeeById,
  providerLookup: (id: string) => { name: string } | null = providerById,
): CaseSummary {
  const emp = employeeLookup(c.employeeId);
  return {
    caseId: c.id,
    employeeId: c.employeeId,
    employeeName: emp?.name ?? c.employeeId,
    site: emp?.site ?? "—",
    providerId: emp?.providerId ?? null,
    // The provider's display name, resolved through the same directory the PCP filter matches ids
    // against. An id that resolves to no provider row keeps the id as its own name rather than
    // rendering blank over a case that does have an attributed clinician.
    providerName: emp?.providerId ? (providerLookup(emp.providerId)?.name ?? emp.providerId) : null,
    payer: emp?.payer ?? null,
    payerName: emp?.payer ? payerNameOf(emp.payer) : null,
    measureId: c.measureId,
    measureVersionId: c.measureId, // slug stands in for the canonical version UUID
    measureName: MEASURES[c.measureId]?.name ?? c.measureId,
    measureVersion: measureVersion(c.measureId),
    evaluationPeriod: c.evaluationPeriod,
    status: c.status,
    priority: c.priority,
    assignee: c.assignee,
    currentOutcomeStatus: c.currentOutcomeStatus,
    nextAction: c.nextAction ?? null,
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
