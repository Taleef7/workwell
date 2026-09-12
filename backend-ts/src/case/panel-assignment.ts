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

/**
 * Subjects named per `listCases` call when collecting a panel's open cases.
 *
 * 900, not 1,000, and the difference is a crash: the SQLite floor expands each id into its own `IN
 * (?, …)` bind, and older builds cap a statement at 999 variables (the same ceiling
 * `worklist-read-model.ts` documents). A thousand ids plus the status binds is 1,004, so a provider
 * with a thousand patients would fail on the floor and succeed on Postgres — after the intent event
 * had already been written.
 */
const SUBJECT_CHUNK = 900;
/** Cases assigned (and audited) per batch — the same cap the operator-facing bulk assign uses. */
const ASSIGN_CHUNK = 500;

const sameAccount = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Which of a provider's open cases a panel change should move.
 *
 * **Two kinds move, and only two.** A case nobody has taken (`assignee` null) — nothing is being
 * overridden. And a case the PANEL itself put somewhere, which is this mapping's own earlier decision
 * being brought up to date.
 *
 * **Any PANEL-sourced case, not only one on the PREVIOUS owner.** Restricting it to the previous
 * owner left a case permanently stranded: a run that snapshotted the old owner can insert a case
 * AFTER the backfill has already scanned, so the row ends up PANEL-sourced on somebody who no longer
 * owns the panel — and a later re-save could not reach it, because by then the previous owner IS the
 * current owner. A PANEL-sourced row belongs to whoever owns the panel now; that is what the source
 * means. Operator-owned rows are excluded exactly as before, so the protection is unchanged.
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
    const panelOwned = c.assignmentSource === "PANEL";
    if (!unowned && !panelOwned) continue;
    // BOTH columns the decision read, so a write that changed only the provenance cannot slip
    // through: an operator re-asserting the same assignee makes the row theirs, and this row must
    // then not move (ADR-080 d1).
    plan.push({ id: c.id, expectedAssignee: c.assignee ?? null, expectedSource: c.assignmentSource });
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
  /**
   * Whether the MAPPING moved. False when the provider was already mapped to this account — in which
   * case nothing is written to `panel_assignments`, though `backfilled` may still be non-zero: a
   * re-save sweeps the panel's unassigned cases onto their owner.
   */
  changed: boolean;
  /** Open cases the plan selected. */
  backfillPlanned: number;
  /** Open cases that actually moved — lower than planned when another writer got there first. */
  backfilled: number;
}

/**
 * Every ACTIVE case belonging to a set of subjects.
 *
 * **One UNBOUNDED read per chunk, deliberately — not offset paging.** `listCases` answers 50 rows
 * unless told otherwise, so a naive read would move the first fifty cases of a panel and leave the
 * rest, which from outside is indistinguishable from a panel that only had fifty. Paging looks like
 * the fix and is not: the ordering is `updated_at DESC`, which a concurrent run or operator MUTATES,
 * so a row can move ahead of the offset and be read twice (two `CASE_ASSIGNED` events for one change)
 * or fall behind it and never be read at all. The work list's own loader passes
 * `Number.MAX_SAFE_INTEGER` for the same reason (`worklist-read-model.ts`): a set that is post-filtered
 * in JavaScript must be loaded whole.
 *
 * The set is bounded by construction — a chunk is at most 900 subjects and a subject has at most one
 * active case per routed measure — so "unbounded" here is a few thousand rows, not a practice.
 *
 * Ids are de-duplicated across chunks as a second line of defence: a case counted twice would be
 * audited twice for one move, and would make `backfillPlanned` describe a different set than
 * `backfilled`.
 */
async function activeCasesForSubjects(cases: CaseStore, subjectIds: readonly string[]): Promise<CaseRecord[]> {
  const byId = new Map<string, CaseRecord>();
  for (let i = 0; i < subjectIds.length; i += SUBJECT_CHUNK) {
    const chunk = subjectIds.slice(i, i + SUBJECT_CHUNK);
    const rows = await cases.listCases({
      employeeIds: chunk,
      statuses: [...ACTIVE_CASE_STATUSES],
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });
    for (const row of rows) byId.set(row.id, row);
  }
  return [...byId.values()];
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

  // Is the MAPPING itself changing? Re-saving the same assignee must not bump updated_at or emit an
  // event describing a change that did not happen. But it must still sweep the panel's UNASSIGNED
  // work: a run whose panel read failed (that read is best-effort, because panels must never fail a
  // run) opens cases unassigned on a mapped panel, and if re-saving did nothing at all the only
  // recovery would be to un-map and re-map. `changed` describes the mapping and `backfilled` the
  // cases, so both numbers stay true and a re-save that moves twelve cases says twelve.
  const mappingChanged = !existing || !sameAccount(previousAssignee, input.assignee);

  const subjectIds = subjectIdsForProvider(deps.roster, input.providerId);
  const openCases = await activeCasesForSubjects(deps.cases, subjectIds);
  const byId = new Map(openCases.map((c) => [c.id, c]));
  const plan = planPanelBackfill(openCases, previousAssignee, input.assignee);

  const now = new Date().toISOString();
  // The panel event first, then the mapping, then the per-case moves — the mapping is the decision and
  // the case moves are its consequence, so a failure part-way leaves a mapping whose backfill can be
  // re-run (re-saving the same panel replays it) rather than moved cases with no mapping to explain them.
  //
  // Emitted when the mapping moves OR when work does. A re-save that changes neither writes nothing:
  // a ledger entry for a decision nobody made is worse than none, because a reader cannot tell it
  // from one that mattered.
  if (mappingChanged || plan.length > 0) await deps.events.appendAudit({
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

  const stored = mappingChanged
    ? await deps.panels.upsertPanelAssignment({
        providerId: input.providerId,
        assignee: input.assignee,
        actor: input.actor,
        now,
      })
    : existing!;

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
    changed: mappingChanged,
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
 * Bring PANEL-sourced cases back in line with the mapping, for a set of subjects.
 *
 * **Why a run needs this at all.** A run reads the panel map ONCE, so every case it opens carries the
 * owner the map named at the start. If a supervisor re-maps that provider mid-run, their PUT's backfill
 * moves what exists AT THAT MOMENT — and the run then keeps inserting cases from its own older
 * snapshot. Those land PANEL-sourced on somebody who no longer owns the panel, and nothing brings them
 * back: a later run's update branch deliberately preserves assignees, and the supervisor has no reason
 * to re-save a panel they already set. The nightly is hours long on the pilot, so this window is wide,
 * not theoretical.
 *
 * Only PANEL-sourced rows move, so an operator's assignment is as safe here as it is in the backfill,
 * and each move carries the state it read so a concurrent write wins over this pass rather than losing.
 *
 * Returns the ids that actually moved; the caller audits exactly those.
 */
export async function reconcilePanelAssignments(
  // Exactly what it uses, so the run pipeline need not hold a whole event store to call it.
  deps: { cases: CaseStore; events: Pick<CaseEventStore, "recordCaseEvents"> },
  input: {
    /** provider → the owner the mapping names NOW. */
    owners: ReadonlyMap<string, string>;
    /** The subjects to consider, grouped by their provider, as the caller already knows them. */
    subjectsByProvider: ReadonlyMap<string, readonly string[]>;
    actor: string;
  },
): Promise<string[]> {
  const moved: string[] = [];
  for (const [providerId, owner] of input.owners) {
    const subjectIds = input.subjectsByProvider.get(providerId);
    if (!subjectIds || subjectIds.length === 0) continue;
    const open = await activeCasesForSubjects(deps.cases, subjectIds);
    const plan = open
      .filter((c) => c.assignmentSource === "PANEL" && !sameAccount(c.assignee, owner))
      .map((c) => ({ id: c.id, expectedAssignee: c.assignee ?? null, expectedSource: c.assignmentSource }));
    if (plan.length === 0) continue;

    const byId = new Map(open.map((c) => [c.id, c]));
    for (let i = 0; i < plan.length; i += ASSIGN_CHUNK) {
      const chunk = plan.slice(i, i + ASSIGN_CHUNK);
      await deps.events.recordCaseEvents(
        chunk.map((entry) => {
          const c = byId.get(entry.id)!;
          const payload = {
            assignee: owner,
            previousAssignee: c.assignee ?? "unassigned",
            bulk: true,
            panel: providerId,
            reason: "PANEL_RECONCILED",
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
      moved.push(...(await deps.cases.assignCases(chunk, owner, "PANEL")));
    }
  }
  return moved;
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
