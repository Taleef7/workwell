/**
 * SQLite/D1 floor implementation of the CaseStore contract (#107). The idempotent
 * upsert uses `INSERT … ON CONFLICT(employee_id, measure_id, evaluation_period) DO UPDATE`
 * so a rerun updates the same row instead of creating a duplicate (the spike's critical
 * case invariant). COMPLIANT resolves an existing case without inserting a new one.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { CaseRecord, CaseQuery, CaseStore, CasePatch, UpsertCaseInput, UpsertedCase } from "../case-store.ts";
import { planCaseUpsert, planNextAction, priorityFor, nextActionFor } from "../../case/case-logic.ts";

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

    // update
    const row = await this.db
      .prepare(
        `UPDATE cases SET status = ?, priority = ?, next_action = ?, next_action_source = ?, current_outcome_status = ?,
           last_run_id = ?, updated_at = ?, closed_at = ?, closed_reason = ?, closed_by = ?
          WHERE employee_id = ? AND measure_id = ? AND evaluation_period = ?
        RETURNING ${COLS}`,
      )
      .bind(
        plan.status!,
        priority,
        action.nextAction,
        action.source,
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
    // UNCHANGED means "nothing an operator would act on moved". `next_action` used to be a function of
    // (status, measure), so a re-confirmed status implied a re-confirmed action; a multi-rate measure's
    // action follows the rate the subject missed (ADR-074 d13), so the same OVERDUE can now carry a new
    // action — a state change the pipeline must audit as UPDATED, not refresh silently.
    const disposition =
      plan.disposition === "UNCHANGED" && existing && existing.next_action !== action.nextAction
        ? "UPDATED"
        : plan.disposition!;
    return row ? { ...toRecord(row), disposition } : null;
  }

  async getCase(id: string): Promise<CaseRecord | null> {
    const row = await this.db.prepare(`SELECT ${COLS} FROM cases WHERE id = ?`).bind(id).first<CaseRow>();
    return row ? toRecord(row) : null;
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
