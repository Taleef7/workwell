/**
 * Case read models (#107) — the worklist `CaseSummary` the frontend consumes,
 * resolving each case row to its employee (name/site, from the synthetic directory)
 * and measure (name from the catalog; logic and version from the case's cited outcome, #769).
 *
 * SLA + waiver/exclusion fields are surfaced as neutral defaults for this slice
 * (exclusionReason/waiver* land with the actions
 * slices); they are optional/nullable in the frontend type.
 */
import type { CaseRecord } from "../stores/case-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { closureKindOf, type ClosureKind } from "./case-logic.ts";
import type { LiveState } from "../compliance/roster-vocabulary.ts";
import { employeeById, providerById } from "../config/deployment-profile.ts";
import { payerNameOf } from "../engine/synthetic/payer-display.ts";
import { measureDisplayName } from "../measure/measure-name.ts";
import type { ScoringLogic } from "../measure/measure-identity.ts";
import { caseLogicKey, scoringForCases } from "./case-scoring-logic.ts";

/**
 * **SLA was REMOVED here, not forgotten (#600).** `slaRemainingDays: null` and `slaBreached: false`
 * shipped hard-coded, so the field always answered "not breached" without anything having checked —
 * a dead value that reads as a checked condition, which is worse than having neither. The `SlaChip`
 * it fed could therefore never render.
 *
 * It is not that nobody built it. The Java implementation had `sla_due_date` and `sla_breached`
 * columns and a six-hourly `escalateBreachedCases()` that bumped priority and wrote a
 * `CASE_SLA_BREACHED` audit event (`docs/archive/JOURNAL_2026-04_06.md`). The de-Java port (ADR-008)
 * carried the SHAPE across and left the computation behind.
 *
 * Reviving it is #600's review date under another name — a `reviewAt` on a closure disposition,
 * which needs columns and is therefore the owner's. Until then the honest surface is no field.
 */
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
  /**
   * The version of the logic that scored the case's CITED outcome (#769) — the artifact's or the
   * translation's own version, the authored library's only for a row authored CQL scored, "" for an
   * errored row or no row. Never the authored library's version for a measure CMS's artifact scores
   * (it read "2.0.0" there). Filled with `logic` by `withScoringLogic`; "" until then.
   */
  measureVersion: string;
  /**
   * The logic that scored the outcome this case cites, `(lastRunId, employeeId, measureId)`, read from
   * that row's own evidence (#769) — never from today's routing, which would relabel a 2026 row the day a
   * translation is routed. Null when nothing named scored it (authored CQL, an errored row, no row).
   * `toCaseSummary` holds no outcome, so it leaves null; a surface fills the rows it SERVES with
   * `withScoringLogic`. On a staff-closed row it names the FROZEN status's logic, not the live one.
   */
  logic: ScoringLogic | null;
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
  /**
   * Number of outreach sends recorded for this case (Java counts `outreach_records`;
   * the TS port derives it from the `OUTREACH_SENT` case_actions). The frontend
   * worklist-gap badge counts open cases with `outreachRecordCount === 0`.
   */
  outreachRecordCount: number;
  /**
   * Who closed the case and when (#569) — carried from the row so a list can say "closed by <person>
   * on <date>" instead of lumping a manual close in with an auto-resolve. `closure` is the derived
   * kind (`closureKindOf`): NONE for an active case, STAFF for every closure a person made, SYSTEM
   * for the run's.
   */
  closedAt: string | null;
  closedReason: string | null;
  closedBy: string | null;
  closure: ClosureKind;
  /**
   * What CQL says TODAY for this subject and measure (#569) — set only on STAFF-closed rows, by
   * `withLiveStatus`, because a staff-closed row's `currentOutcomeStatus` is frozen at closure (the
   * nightly upsert never touches a human closure again) and can therefore be wrong. Absent on every
   * other row: an active row's `currentOutcomeStatus` IS live, and a system-closed row is either
   * still compliant or has been reopened. `liveState` is the tri-state the winning run's cell gives
   * (GAP / CLEAR / UNKNOWN — "not currently evaluable" is its own answer); `liveOutcomeStatus` is
   * the canonical bucket behind it, null when UNKNOWN.
   *
   * **`liveDisplayStatus` is the cell's DISPLAY state, and is what a surface renders.** The canonical
   * bucket alone cannot word a row: a patient the measure no longer describes is canonical
   * `MISSING_DATA` and display `OUT_OF_POPULATION`, so a reader given only the bucket shows
   * "Missing Data" while the CLEAR state reads as "verified compliant" — two false statements about
   * one patient, which is the class of defect this change exists to remove. Both travel.
   */
  liveState?: LiveState;
  liveOutcomeStatus?: string | null;
  liveDisplayStatus?: string | null;
  liveOutcomeRunId?: string | null;
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
    // Any runnable measure's name: the authored registry alone left the four official-only measures
    // as raw ids on the work list and case pages (#659).
    measureName: measureDisplayName(c.measureId),
    // Unknown until the cited row is read (`withScoringLogic`): blank, never a guessed version.
    measureVersion: "",
    logic: null,
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
    outreachRecordCount,
    closedAt: c.closedAt,
    closedReason: c.closedReason,
    closedBy: c.closedBy,
    closure: closureKindOf(c),
  };
}

/**
 * `logic` and `measureVersion` for the summaries a surface SERVES (#769), from each case's cited
 * outcome: one `scoringForCases` call, so one bounded read per (run, measure) on the set — never a read
 * per row. Call it on a PAGE: the filtered set behind a page can be the whole practice (15,309 open
 * cases on the pilot), and only the rows shown need naming.
 */
export async function withScoringLogic<T extends CaseSummary>(
  outcomes: Pick<OutcomeStore, "listOutcomes">,
  summaries: readonly T[],
): Promise<T[]> {
  if (summaries.length === 0) return [];
  const scoring = await scoringForCases(outcomes, summaries);
  return summaries.map((s) => {
    const found = scoring.get(caseLogicKey(s));
    return { ...s, logic: found?.logic ?? null, measureVersion: found?.version ?? "" };
  });
}
