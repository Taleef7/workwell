/**
 * SQLite/D1 floor implementation of the CaseStore contract (#107). The idempotent
 * upsert uses `INSERT … ON CONFLICT(employee_id, measure_id, evaluation_period) DO UPDATE`
 * so a rerun updates the same row instead of creating a duplicate (the spike's critical
 * case invariant). COMPLIANT resolves an existing case without inserting a new one.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { CaseRecord, CaseQuery, CaseStore, CasePatch, UpsertCaseInput, UpsertedCase } from "../case-store.ts";
import { planCaseUpsert, priorityFor, nextActionFor } from "../../case/case-logic.ts";

interface CaseRow {
  id: string;
  employee_id: string;
  measure_id: string;
  evaluation_period: string;
  status: string;
  priority: string;
  assignee: string | null;
  next_action: string | null;
  current_outcome_status: string;
  last_run_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  closed_by: string | null;
}

const COLS =
  "id, employee_id, measure_id, evaluation_period, status, priority, assignee, next_action, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by";

const toRecord = (r: CaseRow): CaseRecord => ({
  id: r.id,
  employeeId: r.employee_id,
  measureId: r.measure_id,
  evaluationPeriod: r.evaluation_period,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee,
  nextAction: r.next_action,
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
    // IN_PROGRESS + human closures), then insert/update/no-op. Read-then-write is non-atomic, but the
    // pipeline processes each (subject, measure, period) key once per run, sequentially, so there is
    // no intra-run race; cross-run same-key concurrency is not a demo scenario (runs are debounced).
    const now = new Date().toISOString();
    const existing = await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod);
    const plan = planCaseUpsert(
      existing ? { status: existing.status, currentOutcomeStatus: existing.current_outcome_status, closedBy: existing.closed_by } : null,
      input.outcomeStatus,
      now,
    );
    if (plan.op === "noop") return null;

    const priority = priorityFor(input.outcomeStatus);
    const nextAction = nextActionFor(input.outcomeStatus, input.measureId);

    if (plan.op === "insert") {
      const row = await this.db
        .prepare(
          `INSERT INTO cases
             (id, employee_id, measure_id, evaluation_period, status, priority, assignee,
              next_action, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING ${COLS}`,
        )
        .bind(
          crypto.randomUUID(),
          input.subjectId,
          input.measureId,
          input.evaluationPeriod,
          plan.status!,
          priority,
          nextAction,
          input.outcomeStatus,
          input.runId,
          now,
          now,
          plan.closedAt ?? null,
          plan.closedReason ?? null,
          plan.closedBy ?? null,
        )
        .first<CaseRow>();
      return row ? { ...toRecord(row), disposition: plan.disposition! } : null;
    }

    // update
    const row = await this.db
      .prepare(
        `UPDATE cases SET status = ?, priority = ?, next_action = ?, current_outcome_status = ?,
           last_run_id = ?, updated_at = ?, closed_at = ?, closed_reason = ?, closed_by = ?
          WHERE employee_id = ? AND measure_id = ? AND evaluation_period = ?
        RETURNING ${COLS}`,
      )
      .bind(
        plan.status!,
        priority,
        nextAction,
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
    return row ? { ...toRecord(row), disposition: plan.disposition! } : null;
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
    if (patch.nextAction !== undefined) (sets.push("next_action = ?"), binds.push(patch.nextAction));
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
