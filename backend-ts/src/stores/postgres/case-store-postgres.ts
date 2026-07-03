/**
 * Postgres-ceiling implementation of the CaseStore contract (#107). Same contract as
 * the SQLite floor; the idempotent upsert uses `INSERT … ON CONFLICT … DO UPDATE` on the
 * UNIQUE (employee_id, measure_id, evaluation_period) key. Fully schema-qualified to the
 * isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import { isUuid, type PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
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
  created_at: Date | string;
  updated_at: Date | string;
  closed_at: Date | string | null;
  closed_reason: string | null;
  closed_by: string | null;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : v);
const COLS =
  "id, employee_id, measure_id, evaluation_period, status, priority, assignee, next_action, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by";
const T = `${SPIKE_SCHEMA}.cases`;

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
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  closedAt: iso(r.closed_at),
  closedReason: r.closed_reason,
  closedBy: r.closed_by,
});

export class PgCaseStore implements CaseStore {
  constructor(private readonly pool: PgPool) {}

  private async findByKey(subjectId: string, measureId: string, evaluationPeriod: string): Promise<CaseRow | null> {
    const { rows } = await this.pool.query<CaseRow>(
      `SELECT ${COLS} FROM ${T} WHERE employee_id = $1 AND measure_id = $2 AND evaluation_period = $3`,
      [subjectId, measureId, evaluationPeriod],
    );
    return rows[0] ?? null;
  }

  async upsertFromOutcome(input: UpsertCaseInput): Promise<UpsertedCase | null> {
    // State-aware upsert (Fable H1/H2) — read-then-plan-then-write, mirroring the SQLite floor via the
    // shared pure `planCaseUpsert`. Preserves IN_PROGRESS, respects human closures, audits real transitions.
    // Concurrency (Codex P2): two runs can overlap on a new key (runs aren't serialized), so the INSERT is
    // `ON CONFLICT DO NOTHING`; if a concurrent writer wins, we re-read and fall through to UPDATE instead
    // of raising a unique violation that would fail one whole run mid-write.
    const now = new Date().toISOString();
    const priority = priorityFor(input.outcomeStatus);
    const nextAction = nextActionFor(input.outcomeStatus, input.measureId);
    const planFrom = (row: CaseRow | null) =>
      planCaseUpsert(row ? { status: row.status, currentOutcomeStatus: row.current_outcome_status, closedBy: row.closed_by } : null, input.outcomeStatus, now);

    let plan = planFrom(await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod));
    if (plan.op === "noop") return null;

    if (plan.op === "insert") {
      const { rows } = await this.pool.query<CaseRow>(
        `INSERT INTO ${T}
           (id, employee_id, measure_id, evaluation_period, status, priority, assignee,
            next_action, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $10, $11, $12, $13)
         ON CONFLICT (employee_id, measure_id, evaluation_period) DO NOTHING
         RETURNING ${COLS}`,
        [
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
          plan.closedAt ?? null,
          plan.closedReason ?? null,
          plan.closedBy ?? null,
        ],
      );
      if (rows[0]) return { ...toRecord(rows[0]), disposition: plan.disposition! };
      // Lost the insert race — re-plan against the now-existing row as an update.
      plan = planFrom(await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod));
      if (plan.op !== "update") return null;
    }

    // update
    const { rows } = await this.pool.query<CaseRow>(
      `UPDATE ${T} SET status = $1, priority = $2, next_action = $3, current_outcome_status = $4,
         last_run_id = $5, updated_at = $6, closed_at = $7, closed_reason = $8, closed_by = $9
        WHERE employee_id = $10 AND measure_id = $11 AND evaluation_period = $12
      RETURNING ${COLS}`,
      [
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
      ],
    );
    return rows[0] ? { ...toRecord(rows[0]), disposition: plan.disposition! } : null;
  }

  async getCase(id: string): Promise<CaseRecord | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<CaseRow>(`SELECT ${COLS} FROM ${T} WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async patchCase(id: string, patch: CasePatch): Promise<CaseRecord | null> {
    if (!isUuid(id)) return null;
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.status !== undefined) sets.push(`status = $${binds.push(patch.status)}`);
    if (patch.priority !== undefined) sets.push(`priority = $${binds.push(patch.priority)}`);
    if (patch.assignee !== undefined) sets.push(`assignee = $${binds.push(patch.assignee)}`);
    if (patch.nextAction !== undefined) sets.push(`next_action = $${binds.push(patch.nextAction)}`);
    if (patch.currentOutcomeStatus !== undefined) sets.push(`current_outcome_status = $${binds.push(patch.currentOutcomeStatus)}`);
    if (patch.lastRunId !== undefined) sets.push(`last_run_id = $${binds.push(patch.lastRunId)}::uuid`);
    if (patch.closedAt !== undefined) sets.push(`closed_at = $${binds.push(patch.closedAt)}`);
    if (patch.closedReason !== undefined) sets.push(`closed_reason = $${binds.push(patch.closedReason)}`);
    if (patch.closedBy !== undefined) sets.push(`closed_by = $${binds.push(patch.closedBy)}`);
    sets.push(`updated_at = $${binds.push(new Date().toISOString())}`);
    const { rows } = await this.pool.query<CaseRow>(
      `UPDATE ${T} SET ${sets.join(", ")} WHERE id = $${binds.push(id)} RETURNING ${COLS}`,
      binds,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async countByLastRun(runId: string): Promise<number> {
    if (!isUuid(runId)) return 0;
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${T} WHERE last_run_id = $1::uuid`,
      [runId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listCases(query: CaseQuery): Promise<CaseRecord[]> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (query.statuses?.length) {
      where.push(`status = ANY($${binds.length + 1})`);
      binds.push(query.statuses);
    }
    if (query.measureId) {
      where.push(`measure_id = $${binds.length + 1}`);
      binds.push(query.measureId);
    }
    if (query.priority) {
      where.push(`LOWER(priority) = LOWER($${binds.length + 1})`);
      binds.push(query.priority);
    }
    if (query.assignee) {
      // Match the Java COALESCE: `assignee=unassigned` selects rows with a NULL assignee.
      where.push(`LOWER(COALESCE(assignee, 'unassigned')) = LOWER($${binds.length + 1})`);
      binds.push(query.assignee);
    }
    // The worklist's current-cycle default is computed per-measure from today's cadence in the route
    // (date-driven, #150 H1 / Codex P2) and applied there; the store filters only by an explicit period.
    const period = query.period?.trim();
    if (period && !["all", "current"].includes(period.toLowerCase())) {
      where.push(`evaluation_period = $${binds.length + 1}`);
      binds.push(period);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    binds.push(query.limit ?? 50, query.offset ?? 0);
    const { rows } = await this.pool.query<CaseRow>(
      `SELECT ${COLS} FROM ${T}${clause} ORDER BY updated_at DESC, id DESC LIMIT $${binds.length - 1} OFFSET $${binds.length}`,
      binds,
    );
    return rows.map(toRecord);
  }
}
