/**
 * Postgres-ceiling implementation of the CaseStore contract (#107). Same contract as
 * the SQLite floor; the idempotent upsert uses `INSERT … ON CONFLICT … DO UPDATE` on the
 * UNIQUE (employee_id, measure_id, evaluation_period) key. Fully schema-qualified to the
 * isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import { isUuid, type PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { CaseRecord, CaseQuery, CaseStore, CasePatch, UpsertCaseInput } from "../case-store.ts";
import { dispositionFor, priorityFor, nextActionFor } from "../../case/case-logic.ts";

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
const OUTCOMES_T = `${SPIKE_SCHEMA}.outcomes`;

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

  async upsertFromOutcome(input: UpsertCaseInput): Promise<CaseRecord | null> {
    const disposition = dispositionFor(input.outcomeStatus);
    const now = new Date().toISOString();

    if (disposition === "RESOLVE") {
      const { rows } = await this.pool.query<CaseRow>(
        `UPDATE ${T} SET status = 'RESOLVED', current_outcome_status = $1, last_run_id = $2, updated_at = $3, closed_at = $3
          WHERE employee_id = $4 AND measure_id = $5 AND evaluation_period = $6
        RETURNING ${COLS}`,
        [input.outcomeStatus, input.runId, now, input.subjectId, input.measureId, input.evaluationPeriod],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    }

    const status = disposition === "EXCLUDED" ? "EXCLUDED" : "OPEN";
    const closedAt = disposition === "EXCLUDED" ? now : null;
    const { rows } = await this.pool.query<CaseRow>(
      `INSERT INTO ${T}
         (id, employee_id, measure_id, evaluation_period, status, priority, assignee,
          next_action, current_outcome_status, last_run_id, created_at, updated_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $10, $11)
       ON CONFLICT (employee_id, measure_id, evaluation_period) DO UPDATE SET
         status = excluded.status,
         priority = excluded.priority,
         next_action = excluded.next_action,
         current_outcome_status = excluded.current_outcome_status,
         last_run_id = excluded.last_run_id,
         updated_at = excluded.updated_at,
         closed_at = excluded.closed_at
       RETURNING ${COLS}`,
      [
        crypto.randomUUID(),
        input.subjectId,
        input.measureId,
        input.evaluationPeriod,
        status,
        priorityFor(input.outcomeStatus),
        nextActionFor(input.outcomeStatus, input.measureId),
        input.outcomeStatus,
        input.runId,
        now,
        closedAt,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
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
    const period = query.period?.trim();
    if (period === "current") {
      // Each measure's LATEST EVALUATED cycle (#150 H1 worklist default): MAX over OUTCOMES (every run
      // writes one outcome per subject, even all-compliant ones), restricted to cycle-anchor periods
      // (…-01-01 / …-07-01). Using outcomes (not open cases) means a measure that rolled into a new cycle
      // with no open cases doesn't fall back to a prior cycle's stale opens (Codex P2); the anchor
      // restriction keeps a pre-bucketing raw-date row from poisoning the MAX (Codex P1). Anchors are the
      // only values CompliancePeriod emits (annual→Jan 1, biannual→Jan 1/Jul 1, seasonal→Jul 1).
      where.push(
        `evaluation_period = (SELECT MAX(o.evaluation_period) FROM ${OUTCOMES_T} o WHERE o.measure_id = ${T}.measure_id AND (o.evaluation_period LIKE '%-01-01' OR o.evaluation_period LIKE '%-07-01'))`,
      );
    } else if (period && period.toLowerCase() !== "all") {
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
