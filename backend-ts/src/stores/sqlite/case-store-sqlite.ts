/**
 * SQLite/D1 floor implementation of the CaseStore contract (#107). The idempotent
 * upsert uses `INSERT … ON CONFLICT(employee_id, measure_id, evaluation_period) DO UPDATE`
 * so a rerun updates the same row instead of creating a duplicate (the spike's critical
 * case invariant). COMPLIANT resolves an existing case without inserting a new one.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { CaseAssignExpectation, CaseRecord, CaseQuery, CaseStore, CasePatch, UpsertCaseInput, UpsertedCase } from "../case-store.ts";
import { ACTIVE_CASE_STATUSES, planCaseUpsert, planNextAction, priorityFor, nextActionFor } from "../../case/case-logic.ts";

interface CaseRow {
  id: string;
  employee_id: string;
  measure_id: string;
  evaluation_period: string;
  status: string;
  priority: string;
  assignee: string | null;
  next_action: string | null;
  next_action_source: string | null;
  current_outcome_status: string;
  last_run_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  closed_by: string | null;
}

const COLS =
  "id, employee_id, measure_id, evaluation_period, status, priority, assignee, next_action, next_action_source, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by";

const toRecord = (r: CaseRow): CaseRecord => ({
  id: r.id,
  employeeId: r.employee_id,
  measureId: r.measure_id,
  evaluationPeriod: r.evaluation_period,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee,
  nextAction: r.next_action,
  nextActionSource: r.next_action_source ?? "SYSTEM",
  currentOutcomeStatus: r.current_outcome_status,
  lastRunId: r.last_run_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
  closedReason: r.closed_reason,
  closedBy: r.closed_by,
});

export class SqliteCaseStore implements CaseStore {
  constructor(private readonly db: CloudDatabase) {}

  private async findByKey(subjectId: string, measureId: string, evaluationPeriod: string): Promise<CaseRow | null> {
    return (
      (await this.db
        .prepare(`SELECT ${COLS} FROM cases WHERE employee_id = ? AND measure_id = ? AND evaluation_period = ?`)
        .bind(subjectId, measureId, evaluationPeriod)
        .first<CaseRow>()) ?? null
    );
  }

  async upsertFromOutcome(input: UpsertCaseInput): Promise<UpsertedCase | null> {
    // State-aware upsert (Fable H1/H2): read the current row, plan the transition (respecting
    // IN_PROGRESS + human closures), then insert/update/no-op.
    // Concurrency (Codex P2): the pipeline processes each key once per run, sequentially, but two runs
    // CAN overlap on a new key (a manual double-click, or a scheduler/manual overlap — runs aren't
    // serialized). So the INSERT is conflict-tolerant (`ON CONFLICT DO NOTHING`): if a concurrent writer
    // wins the insert, we re-read and fall through to the UPDATE path instead of throwing a unique
    // violation (which would fail one whole run mid-write, as the old atomic ON CONFLICT never did).
    const now = new Date().toISOString();
    const priority = priorityFor(input.outcomeStatus);
    const computedAction = nextActionFor(input.outcomeStatus, input.measureId, input.evidence);
    let existing = await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod);
    let action = planNextAction(
      existing
        ? {
            nextAction: existing.next_action,
            nextActionSource: existing.next_action_source,
            currentOutcomeStatus: existing.current_outcome_status,
          }
        : null,
      computedAction,
      input.outcomeStatus,
    );
    let plan = planCaseUpsert(
      existing ? { status: existing.status, currentOutcomeStatus: existing.current_outcome_status, closedBy: existing.closed_by } : null,
      input.outcomeStatus,
      now,
      { outOfPopulation: input.outOfPopulation },
    );
    if (plan.op === "noop") return null;

    if (plan.op === "insert") {
      const row = await this.db
        .prepare(
          `INSERT INTO cases
             (id, employee_id, measure_id, evaluation_period, status, priority, assignee,
              next_action, next_action_source, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (employee_id, measure_id, evaluation_period) DO NOTHING
           RETURNING ${COLS}`,
        )
        .bind(
          crypto.randomUUID(),
          input.subjectId,
          input.measureId,
          input.evaluationPeriod,
          plan.status!,
          priority,
          action.nextAction,
          action.source,
          input.outcomeStatus,
          input.runId,
          now,
          now,
          plan.closedAt ?? null,
          plan.closedReason ?? null,
          plan.closedBy ?? null,
        )
        .first<CaseRow>();
      if (row) return { ...toRecord(row), disposition: plan.disposition! };
      // Lost the insert race — the row now exists; re-plan against it as an update.
      existing = await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod);
      plan = planCaseUpsert(
        existing ? { status: existing.status, currentOutcomeStatus: existing.current_outcome_status, closedBy: existing.closed_by } : null,
        input.outcomeStatus,
        now,
        { outOfPopulation: input.outOfPopulation },
      );
      // The winner of the race may have written an operator-owned action between our read and theirs.
      action = planNextAction(
        existing
          ? {
              nextAction: existing.next_action,
              nextActionSource: existing.next_action_source,
              currentOutcomeStatus: existing.current_outcome_status,
            }
          : null,
        computedAction,
        input.outcomeStatus,
      );
      if (plan.op !== "update") return null;
    }

    // update — a COMPARE-AND-SET on the two columns an operator can move under us, mirroring the Pg
    // ceiling. `planNextAction` decides from a row read microseconds earlier, and an operator can
    // escalate in that window; an unconditional write would put the run's already-stale action over
    // their instruction and reset ownership to SYSTEM, and where the status and computed action matched
    // the snapshot the disposition would still say UNCHANGED, so the clobber would not be audited
    // either. `IS ?` is SQLite's null-safe comparison, the counterpart of the ceiling's
    // `IS NOT DISTINCT FROM` (Codex P2, #538).
    const attemptUpdate = async (from: CaseRow, p: typeof plan, a: typeof action) =>
      await this.db
        .prepare(
          `UPDATE cases SET status = ?, priority = ?, next_action = ?, next_action_source = ?, current_outcome_status = ?,
             last_run_id = ?, updated_at = ?, closed_at = ?, closed_reason = ?, closed_by = ?
            WHERE employee_id = ? AND measure_id = ? AND evaluation_period = ?
              AND next_action IS ? AND next_action_source IS ?
          RETURNING ${COLS}`,
        )
        .bind(
          p.status!,
          priority,
          a.nextAction,
          a.source,
          input.outcomeStatus,
          input.runId,
          now,
          p.closedAt ?? null,
          p.closedReason ?? null,
          p.closedBy ?? null,
          input.subjectId,
          input.measureId,
          input.evaluationPeriod,
          from.next_action,
          from.next_action_source,
        )
        .first<CaseRow>();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!existing) return null;
      const row = await attemptUpdate(existing, plan, action);
      if (row) {
        // UNCHANGED means "nothing an operator would act on moved". `next_action` used to be a function
        // of (status, measure), so a re-confirmed status implied a re-confirmed action; a multi-rate
        // measure's action follows the rate the subject missed (ADR-074 d13), so the same OVERDUE can
        // carry a new action — a state change the pipeline must audit as UPDATED, not refresh silently.
        const disposition =
          plan.disposition === "UNCHANGED" && existing.next_action !== row.next_action ? "UPDATED" : plan.disposition!;
        return { ...toRecord(row), disposition };
      }
      existing = await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod);
      if (!existing) return null;
      plan = planCaseUpsert(
        { status: existing.status, currentOutcomeStatus: existing.current_outcome_status, closedBy: existing.closed_by },
        input.outcomeStatus,
        now,
        { outOfPopulation: input.outOfPopulation },
      );
      if (plan.op !== "update") return null;
      action = planNextAction(
        {
          nextAction: existing.next_action,
          nextActionSource: existing.next_action_source,
          currentOutcomeStatus: existing.current_outcome_status,
        },
        computedAction,
        input.outcomeStatus,
      );
    }

    // Contended past three attempts. Write what the run owns and leave the action alone: the run's
    // wording is recoverable on the next tick, an operator's instruction is not.
    const fallback = await this.db
      .prepare(
        `UPDATE cases SET status = ?, priority = ?, current_outcome_status = ?, last_run_id = ?,
           updated_at = ?, closed_at = ?, closed_reason = ?, closed_by = ?
          WHERE employee_id = ? AND measure_id = ? AND evaluation_period = ?
        RETURNING ${COLS}`,
      )
      .bind(
        plan.status!,
        priority,
        input.outcomeStatus,
        input.runId,
        now,
        plan.closedAt ?? null,
        plan.closedReason ?? null,
        plan.closedBy ?? null,
        input.subjectId,
        input.measureId,
        input.evaluationPeriod,
      )
      .first<CaseRow>();
    return fallback ? { ...toRecord(fallback), disposition: plan.disposition! } : null;
  }

  /**
   * The floor's `upsertFromOutcomes` is a LOOP over the single-row upsert, and deliberately so.
   *
   * The batching exists to collapse network round trips to Neon; SQLite is a local file with none, so
   * a set-based rewrite here would buy nothing and would be a second implementation of the subtlest
   * rule in the store (ADR-076 d2's compare-and-set) to keep in step with the first.
   *
   * State it plainly because it has a cost: every batch-shaped contract test passes on this floor
   * without exercising any set-based SQL. The Postgres ceiling is where that path is really tested —
   * `docker compose -f infra/docker-compose.yml up -d postgres`, then
   * `node --import tsx --test src/stores/postgres/store-postgres.test.ts`. A green floor is not
   * evidence for the ceiling here.
   *
   * The duplicate-key refusal is NOT skipped: it is part of the contract rather than an artifact of
   * the set-based write, so a caller cannot develop against the floor and discover it in production.
   */
  async upsertFromOutcomes(inputs: UpsertCaseInput[]): Promise<(UpsertedCase | null)[]> {
    const seen = new Set<string>();
    for (const i of inputs) {
      // NUL-joined, matching the ceiling. A space separator would make the floor throw on a batch the
      // ceiling accepts, whenever a subject id contains a space — the two stores must agree on what a
      // duplicate IS, or a caller can develop against one and be refused by the other.
      const k = `${i.subjectId}\u0000${i.measureId}\u0000${i.evaluationPeriod}`;
      if (seen.has(k)) {
        throw new Error(
          `upsertFromOutcomes: duplicate key in one batch (${i.subjectId}, ${i.measureId}, ${i.evaluationPeriod}) — a set-based update would apply one of them arbitrarily`,
        );
      }
      seen.add(k);
    }
    const out: (UpsertedCase | null)[] = [];
    for (const input of inputs) out.push(await this.upsertFromOutcome(input));
    return out;
  }

  async getCase(id: string): Promise<CaseRecord | null> {
    const row = await this.db.prepare(`SELECT ${COLS} FROM cases WHERE id = ?`).bind(id).first<CaseRow>();
    return row ? toRecord(row) : null;
  }

  async getCases(ids: readonly string[]): Promise<CaseRecord[]> {
    if (ids.length === 0) return [];
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM cases WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids)
      .all<CaseRow>();
    return (results ?? []).map(toRecord);
  }

  async assignCases(expected: readonly CaseAssignExpectation[], assignee: string | null): Promise<string[]> {
    if (expected.length === 0) return [];
    // Grouped by the assignee the caller READ, then one statement per distinct value. The floor has no
    // portable way to zip two arrays into a join the way Postgres's `unnest` does, and the number of
    // distinct prior owners in one batch is tiny (the assignable accounts, plus unassigned) — so this
    // is a handful of statements rather than one per case, and it asks the SAME question the ceiling
    // asks: update only while the row still holds the value the caller read.
    const byExpected = new Map<string | null, string[]>();
    for (const entry of expected) {
      const ids = byExpected.get(entry.expectedAssignee);
      if (ids) ids.push(entry.id);
      else byExpected.set(entry.expectedAssignee, [entry.id]);
    }

    const active = [...ACTIVE_CASE_STATUSES];
    const now = new Date().toISOString();
    const changed: string[] = [];
    for (const [expectedAssignee, ids] of byExpected) {
      // `IS` is SQLite's NULL-safe equality and `IS NOT` its NULL-safe inequality — the counterparts
      // of Postgres's `IS NOT DISTINCT FROM` / `IS DISTINCT FROM`. Plain `=` / `<>` are NULL for an
      // unassigned row, and assigning an unassigned case is the commonest thing this is asked to do.
      const { results } = await this.db
        .prepare(
          `UPDATE cases SET assignee = ?, updated_at = ?
            WHERE id IN (${ids.map(() => "?").join(", ")})
              AND status IN (${active.map(() => "?").join(", ")})
              AND assignee IS ?
              AND assignee IS NOT ?
          RETURNING id`,
        )
        .bind(assignee, now, ...ids, ...active, expectedAssignee, assignee)
        .all<{ id: string }>();
      for (const row of results ?? []) changed.push(row.id);
    }
    return changed;
  }

  async patchCase(id: string, patch: CasePatch): Promise<CaseRecord | null> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.status !== undefined) (sets.push("status = ?"), binds.push(patch.status));
    if (patch.priority !== undefined) (sets.push("priority = ?"), binds.push(patch.priority));
    if (patch.assignee !== undefined) (sets.push("assignee = ?"), binds.push(patch.assignee));
    // `patchCase` is the operator surface (escalate, manual resolve, outreach, rerun-to-verify); the
    // system writes actions through `upsertFromOutcome`. So writing an action here transfers ownership
    // to OPERATOR unless the caller explicitly says the action is system-computed.
    if (patch.nextAction !== undefined) {
      sets.push("next_action = ?");
      binds.push(patch.nextAction);
      sets.push("next_action_source = ?");
      binds.push(patch.nextActionSource ?? "OPERATOR");
    } else if (patch.nextActionSource !== undefined) {
      sets.push("next_action_source = ?");
      binds.push(patch.nextActionSource);
    }
    if (patch.currentOutcomeStatus !== undefined) (sets.push("current_outcome_status = ?"), binds.push(patch.currentOutcomeStatus));
    if (patch.lastRunId !== undefined) (sets.push("last_run_id = ?"), binds.push(patch.lastRunId));
    if (patch.closedAt !== undefined) (sets.push("closed_at = ?"), binds.push(patch.closedAt));
    if (patch.closedReason !== undefined) (sets.push("closed_reason = ?"), binds.push(patch.closedReason));
    if (patch.closedBy !== undefined) (sets.push("closed_by = ?"), binds.push(patch.closedBy));
    sets.push("updated_at = ?");
    binds.push(new Date().toISOString());
    const row = await this.db
      .prepare(`UPDATE cases SET ${sets.join(", ")} WHERE id = ? RETURNING ${COLS}`)
      .bind(...binds, id)
      .first<CaseRow>();
    return row ? toRecord(row) : null;
  }

  async countByLastRun(runId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM cases WHERE last_run_id = ?")
      .bind(runId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async listCases(query: CaseQuery): Promise<CaseRecord[]> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (query.statuses?.length) {
      where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      binds.push(...query.statuses);
    }
    if (query.employeeId) {
      where.push("employee_id = ?");
      binds.push(query.employeeId);
    }
    if (query.employeeIds !== undefined) {
      // An EMPTY set is "nobody matches", not "no filter" — `IN ()` is a syntax error, so it becomes a
      // predicate that is false for every row. A panel with no patients must return no cases; falling
      // through to unfiltered would serve the whole practice under that panel's heading.
      if (query.employeeIds.length === 0) {
        where.push("1 = 0");
      } else {
        where.push(`employee_id IN (${query.employeeIds.map(() => "?").join(", ")})`);
        binds.push(...query.employeeIds);
      }
    }
    if (query.measureId) {
      where.push("measure_id = ?");
      binds.push(query.measureId);
    }
    if (query.priority) {
      where.push("LOWER(priority) = LOWER(?)");
      binds.push(query.priority);
    }
    if (query.assignee) {
      // Match the Java COALESCE: `assignee=unassigned` selects rows with a NULL assignee.
      where.push("LOWER(COALESCE(assignee, 'unassigned')) = LOWER(?)");
      binds.push(query.assignee);
    }
    // The worklist's current-cycle default is computed per-measure from today's cadence in the route
    // (date-driven, #150 H1 / Codex P2) and applied there; the store filters only by an explicit period.
    const period = query.period?.trim();
    if (period && !["all", "current"].includes(period.toLowerCase())) {
      where.push("evaluation_period = ?");
      binds.push(period);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM cases${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<CaseRow>();
    return (results ?? []).map(toRecord);
  }
}
