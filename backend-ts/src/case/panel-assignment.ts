/**
 * Provider panels (MM-2 PR 2, ADR-080) — mapping a provider to the staff account that works their
 * patients, and moving the open work when that mapping changes.
 *
 * The practice already works this way: their staff are assigned to specific providers, and the same
 * patient lives in one provider's panel, so one person closes all of that patient's gaps rather than
 * five people touching five measures. Until this module existed, WorkWell knew nothing about it —
 * every case a nightly run opened arrived unassigned, and the arrangement had to be re-applied by
 * hand each morning.
 *
 * Two halves, and the second is the delicate one:
 *   - **Forward**: the run pipeline reads `panelMapFor` once per run and opens each new case already
 *     assigned (the store's `panelAssignee`, insert branch only).
 *   - **Backward**: mapping a panel moves the cases that are ALREADY open — but only the ones the
 *     panel owns. `planPanelBackfill` is that judgement, and it is pure so it can be argued with.
 *
 * Ordering, as everywhere else that mutates a case: the audit event is written BEFORE the mutation
 * (`case-actions.ts`), so a failure can only ever leave a recorded-but-unapplied action rather than
 * an unaudited state change.
 */
import type { CaseAssignExpectation, CaseRecord, CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { PanelAssignment, PanelStore } from "../stores/panel-store.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { ACTIVE_CASE_STATUSES } from "./case-logic.ts";

/** Subjects named per `listCases` call when collecting a panel's open cases. */
const SUBJECT_CHUNK = 1_000;
/**
 * Rows per page of that read.
 *
 * `listCases` DEFAULTS to 50 rows, and a backfill that took one page would move the first fifty cases
 * of a panel and silently leave the rest — indistinguishable, from the outside, from a panel that only
 * had fifty. So the read pages to exhaustion rather than passing a large limit, because any limit
 * large enough to "obviously" cover a panel is still a number somebody's panel can exceed.
 */
const CASE_PAGE = 500;
/** Cases assigned (and audited) per batch — the same cap the operator-facing bulk assign uses. */
const ASSIGN_CHUNK = 500;

const sameAccount = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Which of a provider's open cases a panel change should move.
 *
 * **Two kinds move, and only two.** A case nobody has taken (`assignee` null) — nothing is being
 * overridden. And a case the PANEL itself put on the previous owner, which is this mapping's own
 * earlier decision being brought up to date.
 *
 * **Everything else stays put**, and that is the entire reason `assignment_source` exists (ADR-080
 * d1). Without it the only available test is "assignee == the previous panel owner" — which is also
 * true of a case a supervisor deliberately handed to that same person, and of every case assigned
 * before the column existed. Moving those would silently overrule a human decision, at panel scale,
 * with the only evidence being an audit trail nobody reads until something has already gone wrong.
 * A NULL source with an assignee therefore reads as operator-owned: the safe reading is the one that
 * declines to move the row.
 *
 * A case already on the new owner is not a change and is skipped, so it is neither reported nor
 * audited — the no-op rule the bulk path established.
 *
 * Returns compare-and-set expectations: each carries the owner this function READ, so a row someone
 * moves between the read and the write is skipped rather than overwritten.
 */
export function planPanelBackfill(
  cases: readonly CaseRecord[],
  previousOwner: string | null,
  newOwner: string,
): CaseAssignExpectation[] {
  const active = new Set<string>(ACTIVE_CASE_STATUSES);
  const plan: CaseAssignExpectation[] = [];
  for (const c of cases) {
    if (!active.has(c.status)) continue;
    if (sameAccount(c.assignee, newOwner)) continue;
    const unowned = c.assignee == null;
    const panelOwned =
      c.assignmentSource === "PANEL" && previousOwner != null && sameAccount(c.assignee, previousOwner);
    if (!unowned && !panelOwned) continue;
    plan.push({ id: c.id, expectedAssignee: c.assignee ?? null });
  }
  return plan;
}

/**
 * Every subject in the directory attributed to one provider.
 *
 * Deliberately NOT `panelSubjectIds` from the work list's read model: that one caps at 900 ids and
 * returns `undefined` above the cap, because it is a query OPTIMISATION where falling back to "no
 * pre-filter" is merely slower. Here the id set decides which cases get moved, so a cap would mean a
 * panel silently backfilling part of itself.
 */
export function subjectIdsForProvider(roster: readonly EmployeeProfile[], providerId: string): string[] {
  const ids: string[] = [];
  for (const employee of roster) if (employee.providerId === providerId) ids.push(employee.externalId);
  return ids;
}

/** The provider → assignee map a run applies to the cases it opens. */
export function panelMapFor(panels: readonly PanelAssignment[]): Map<string, string> {
  return new Map(panels.map((p) => [p.providerId, p.assignee]));
}

export interface PanelServiceDeps {
  panels: PanelStore;
  cases: CaseStore;
  events: CaseEventStore;
  /** The complete directory for this deployment — the source of "whose patients are these". */
  roster: readonly EmployeeProfile[];
}

export interface PanelChangeResult {
  providerId: string;
  assignee: string;
  previousAssignee: string | null;
  /** False when the provider was already mapped to this account: nothing written, nothing audited. */
  changed: boolean;
  /** Open cases the plan selected. */
  backfillPlanned: number;
  /** Open cases that actually moved — lower than planned when another writer got there first. */
  backfilled: number;
}

/**
 * Every ACTIVE case belonging to a set of subjects, read to exhaustion.
 *
 * Two loops, for two different limits: the subject ids are chunked so one statement never carries a
 * whole practice's worth of bind parameters, and each chunk is then PAGED because `listCases` answers
 * 50 rows unless told otherwise. Nothing writes during this pass, so offset paging is stable.
 */
async function activeCasesForSubjects(cases: CaseStore, subjectIds: readonly string[]): Promise<CaseRecord[]> {
  const found: CaseRecord[] = [];
  for (let i = 0; i < subjectIds.length; i += SUBJECT_CHUNK) {
    const chunk = subjectIds.slice(i, i + SUBJECT_CHUNK);
    for (let offset = 0; ; offset += CASE_PAGE) {
      const page = await cases.listCases({
        employeeIds: chunk,
        statuses: [...ACTIVE_CASE_STATUSES],
        limit: CASE_PAGE,
        offset,
      });
      found.push(...page);
      if (page.length < CASE_PAGE) break;
    }
  }
  return found;
}

/**
 * Map a provider to a staff account and bring their open work with it.
 *
 * The caller (the route) has already resolved the provider and validated the assignee, so this is
 * only the write path. Cases are read and assigned in chunks: a provider at the pilot has a few
 * hundred patients over six routed measures, and a set-based assign of the whole panel in one
 * statement is what keeps this inside a worker deadline on Neon.
 */
export async function assignPanel(
  deps: PanelServiceDeps,
  input: { providerId: string; assignee: string; actor: string; providerName?: string | null },
): Promise<PanelChangeResult> {
  const existing = await deps.panels.getPanelAssignment(input.providerId);
  const previousAssignee = existing?.assignee ?? null;

  // Already this account's panel. Writing anyway would bump updated_at and emit an event describing a
  // change that did not happen — and, worse, would re-run a backfill whose "previous owner" is the
  // new owner, which selects nothing but reads the whole panel to find that out.
  if (existing && sameAccount(previousAssignee, input.assignee)) {
    return {
      providerId: input.providerId,
      assignee: existing.assignee,
      previousAssignee,
      changed: false,
      backfillPlanned: 0,
      backfilled: 0,
    };
  }

  const subjectIds = subjectIdsForProvider(deps.roster, input.providerId);
  const openCases = await activeCasesForSubjects(deps.cases, subjectIds);
  const byId = new Map(openCases.map((c) => [c.id, c]));
  const plan = planPanelBackfill(openCases, previousAssignee, input.assignee);

  const now = new Date().toISOString();
  // The panel event first, then the mapping, then the per-case moves — the mapping is the decision and
  // the case moves are its consequence, so a failure part-way leaves a mapping whose backfill can be
  // re-run (re-mapping the same panel replays it) rather than moved cases with no mapping to explain them.
  await deps.events.appendAudit({
    eventType: "PANEL_ASSIGNED",
    entityType: "panel",
    entityId: input.providerId,
    actor: input.actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: {
      providerId: input.providerId,
      ...(input.providerName ? { providerName: input.providerName } : {}),
      assignee: input.assignee,
      previousAssignee: previousAssignee ?? "unassigned",
      backfillPlanned: plan.length,
    },
  });

  const stored = await deps.panels.upsertPanelAssignment({
    providerId: input.providerId,
    assignee: input.assignee,
    actor: input.actor,
    now,
  });

  let backfilled = 0;
  for (let i = 0; i < plan.length; i += ASSIGN_CHUNK) {
    const chunk = plan.slice(i, i + ASSIGN_CHUNK);
    // `recordCaseEvents`, not `appendAudits`: a case moved by a panel edit must leave the same rows a
    // case moved by hand does, or the ledger's shape depends on which screen the change was made from.
    await deps.events.recordCaseEvents(
      chunk.map((entry) => {
        const c = byId.get(entry.id)!;
        const payload = {
          assignee: input.assignee,
          previousAssignee: c.assignee ?? "unassigned",
          bulk: true,
          panel: input.providerId,
        };
        return {
          action: { caseId: c.id, actionType: "ASSIGNED", actor: input.actor, payload },
          audit: {
            eventType: "CASE_ASSIGNED",
            entityType: "case",
            entityId: c.id,
            actor: input.actor,
            refRunId: c.lastRunId,
            refCaseId: c.id,
            refMeasureVersionId: c.measureId,
            payload,
          },
        };
      }),
    );
    // 'PANEL': this assignment is the mapping's, so a LATER panel change may move it again. That is
    // the whole provenance loop — an operator's assignment made from a screen is 'OPERATOR' and stays.
    const moved = await deps.cases.assignCases(chunk, input.assignee, "PANEL");
    backfilled += moved.length;
  }

  return {
    providerId: input.providerId,
    assignee: stored.assignee,
    previousAssignee,
    changed: true,
    backfillPlanned: plan.length,
    backfilled,
  };
}

/**
 * Remove a provider's mapping. Returns the removed row, or null when nobody owned that panel.
 *
 * **Open cases keep their assignee** (ADR-080 d4). Un-mapping a panel says who owns FUTURE work; it is
 * not an instruction to drop what somebody is in the middle of, and silently unassigning a few hundred
 * cases because a supervisor tidied a mapping would lose real work. Moving open cases is bulk assign,
 * which is per-case and audited as such.
 */
export async function unassignPanel(
  deps: Pick<PanelServiceDeps, "panels" | "events">,
  input: { providerId: string; actor: string },
): Promise<PanelAssignment | null> {
  const existing = await deps.panels.getPanelAssignment(input.providerId);
  if (!existing) return null;
  await deps.events.appendAudit({
    eventType: "PANEL_UNASSIGNED",
    entityType: "panel",
    entityId: input.providerId,
    actor: input.actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: { providerId: input.providerId, previousAssignee: existing.assignee },
  });
  return deps.panels.removePanelAssignment(input.providerId);
}

/**
 * The provider ids one account's panels cover.
 *
 * Case-insensitive because an account's stored spelling and the JWT's may differ in case, and "my
 * panel" returning an empty list because of that would read as "no work assigned to me" — the exact
 * misreading this feature exists to prevent.
 */
export function providerIdsOwnedBy(panels: readonly PanelAssignment[], assignee: string | null | undefined): string[] {
  if (!assignee || !assignee.trim()) return [];
  return panels.filter((p) => sameAccount(p.assignee, assignee)).map((p) => p.providerId);
}
