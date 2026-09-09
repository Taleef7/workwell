/**
 * Postgres-ceiling implementation of the CaseStore contract (#107). Same contract as
 * the SQLite floor; the idempotent upsert uses `INSERT … ON CONFLICT … DO UPDATE` on the
 * UNIQUE (employee_id, measure_id, evaluation_period) key. Fully schema-qualified to the
 * isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import { isUuid, type PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
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
  created_at: Date | string;
  updated_at: Date | string;
  closed_at: Date | string | null;
  closed_reason: string | null;
  closed_by: string | null;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : v);
const COLS =
  "id, employee_id, measure_id, evaluation_period, status, priority, assignee, next_action, next_action_source, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by";
/**
 * The same list qualified to the `c` alias. The batched UPDATE joins a `VALUES` alias that carries
 * `employee_id`/`measure_id`/`evaluation_period` too, so an unqualified RETURNING is ambiguous and
 * Postgres refuses the statement.
 */
const COLS_C = COLS.split(", ")
  .map((col) => `c.${col}`)
  .join(", ");
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
  nextActionSource: r.next_action_source ?? "SYSTEM",
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
    const computedAction = nextActionFor(input.outcomeStatus, input.measureId, input.evidence);
    const planFrom = (row: CaseRow | null) =>
      planCaseUpsert(row ? { status: row.status, currentOutcomeStatus: row.current_outcome_status, closedBy: row.closed_by } : null, input.outcomeStatus, now, {
        outOfPopulation: input.outOfPopulation,
      });
    // An operator's instruction outlives a run that learned nothing new (`planNextAction`).
    const actionFrom = (row: CaseRow | null) =>
      planNextAction(
        row
          ? {
              nextAction: row.next_action,
              nextActionSource: row.next_action_source,
              currentOutcomeStatus: row.current_outcome_status,
            }
          : null,
        computedAction,
        input.outcomeStatus,
      );

    let existing = await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod);
    let plan = planFrom(existing);
    let action = actionFrom(existing);
    if (plan.op === "noop") return null;

    if (plan.op === "insert") {
      const { rows } = await this.pool.query<CaseRow>(
        `INSERT INTO ${T}
           (id, employee_id, measure_id, evaluation_period, status, priority, assignee,
            next_action, next_action_source, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $11, $12, $13, $14)
         ON CONFLICT (employee_id, measure_id, evaluation_period) DO NOTHING
         RETURNING ${COLS}`,
        [
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
          plan.closedAt ?? null,
          plan.closedReason ?? null,
          plan.closedBy ?? null,
        ],
      );
      if (rows[0]) return { ...toRecord(rows[0]), disposition: plan.disposition! };
      // Lost the insert race — re-plan against the now-existing row as an update.
      existing = await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod);
      plan = planFrom(existing);
      action = actionFrom(existing);
      if (plan.op !== "update") return null;
    }

    // update — a COMPARE-AND-SET on the two columns an operator can move under us.
    //
    // `planNextAction` decides from a row we read microseconds earlier, and an operator can escalate a
    // case in that window. An unconditional UPDATE would then write the run's already-stale action over
    // their instruction and reset ownership to SYSTEM — and if the status and computed action matched
    // the snapshot the disposition would still be UNCHANGED, so the clobber would not even be audited.
    // A silent loss of an operator's words is the exact thing ADR-076 d2 exists to prevent, so it must
    // not survive as a race (Codex P2, #538).
    //
    // The guard is in the WHERE clause rather than a transaction because this store talks to a pooled
    // `pool.query` with no session to hold a lock in, and because a CAS keeps `planNextAction` the ONE
    // definition of the rule — expressing it as a SQL `CASE` instead would make the pure function dead
    // on the path that matters and its unit tests vacuous.
    const attemptUpdate = async (from: CaseRow, p: typeof plan, a: typeof action) =>
      (
        await this.pool.query<CaseRow>(
          `UPDATE ${T} SET status = $1, priority = $2, next_action = $3, next_action_source = $4,
             current_outcome_status = $5, last_run_id = $6, updated_at = $7, closed_at = $8,
             closed_reason = $9, closed_by = $10
            WHERE employee_id = $11 AND measure_id = $12 AND evaluation_period = $13
              AND next_action IS NOT DISTINCT FROM $14
              AND next_action_source IS NOT DISTINCT FROM $15
          RETURNING ${COLS}`,
          [
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
          ],
        )
      ).rows[0];

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!existing) return null;
      const row = await attemptUpdate(existing, plan, action);
      if (row) {
        // Mirrors the SQLite floor: a re-confirmed status whose rate-aware `next_action` moved is
        // UPDATED, never a silent refresh (ADR-074 d13). Compared against what was WRITTEN.
        const disposition =
          plan.disposition === "UNCHANGED" && existing.next_action !== row.next_action ? "UPDATED" : plan.disposition!;
        return { ...toRecord(row), disposition };
      }
      // Nothing matched: the action moved between our read and our write. Re-read and re-plan — the
      // same shape as the lost-insert-race path above.
      existing = await this.findByKey(input.subjectId, input.measureId, input.evaluationPeriod);
      if (!existing) return null;
      plan = planFrom(existing);
      if (plan.op !== "update") return null;
      action = actionFrom(existing);
    }

    // Contended past three attempts — somebody is actively working this case. Write everything the run
    // owns and leave the action alone: the run's outcome is recorded, and the operator keeps their
    // words. Losing the run's wording is recoverable on the next tick; losing theirs is not.
    const { rows: fallback } = await this.pool.query<CaseRow>(
      `UPDATE ${T} SET status = $1, priority = $2, current_outcome_status = $3, last_run_id = $4,
         updated_at = $5, closed_at = $6, closed_reason = $7, closed_by = $8
        WHERE employee_id = $9 AND measure_id = $10 AND evaluation_period = $11
      RETURNING ${COLS}`,
      [
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
      ],
    );
    return fallback[0] ? { ...toRecord(fallback[0]), disposition: plan.disposition! } : null;
  }

  /**
   * The chunk-at-a-time upsert (see `CaseStore.upsertFromOutcomes`). Four statements per sub-chunk
   * instead of two round trips per row.
   *
   * The shape is: read every existing row for the batch's keys in ONE query, plan in memory with the
   * same pure `planCaseUpsert`/`planNextAction` the per-row path uses, then one multi-row INSERT and
   * one set-based UPDATE. `planNextAction` stays the single definition of the ownership rule — SQL
   * only compares the values we read and writes the values we already decided, exactly as the
   * single-row CAS does. Expressing the rule as a SQL `CASE` would make the pure function dead on the
   * path that matters and its unit tests vacuous.
   *
   * Anything that does not go cleanly through the batch — a key another writer inserted first, a row
   * whose `next_action` moved under us — falls back to `upsertFromOutcome` for that row alone. That
   * path already re-reads, re-plans, retries three times and then writes the action-preserving
   * fallback; re-implementing it here would be a second copy of the subtlest rule in the store.
   */
  async upsertFromOutcomes(inputs: UpsertCaseInput[]): Promise<(UpsertedCase | null)[]> {
    if (inputs.length === 0) return [];
    const now = new Date().toISOString();
    const keyOf = (i: Pick<UpsertCaseInput, "subjectId" | "measureId" | "evaluationPeriod">) =>
      `${i.subjectId}\u0000${i.measureId}\u0000${i.evaluationPeriod}`;

    // A duplicate key would be applied once, from an arbitrary tuple, by the set-based UPDATE — where
    // the sequential path applied both in order. Refuse rather than silently pick.
    const seen = new Set<string>();
    for (const i of inputs) {
      const k = keyOf(i);
      if (seen.has(k)) {
        throw new Error(
          `upsertFromOutcomes: duplicate key in one batch (${i.subjectId}, ${i.measureId}, ${i.evaluationPeriod}) — a set-based update would apply one of them arbitrarily`,
        );
      }
      seen.add(k);
    }

    const results: (UpsertedCase | null)[] = new Array(inputs.length).fill(null);
    // Sub-chunked so the bind count stays far below Postgres' 65535 cap — 13 params/row on the insert
    // plus one hoisted `now`, and 14 on the update plus one hoisted `now`, so 500 rows is about 7,000
    // either way — and so each statement stays a reasonable size. 500 also matches `recordOutcomes`
    // and the pipeline's own subject chunk.
    const CHUNK = 500;
    for (let start = 0; start < inputs.length; start += CHUNK) {
      const batch = inputs.slice(start, start + CHUNK).map((input, offset) => ({ input, index: start + offset }));
      await this.upsertBatchChunk(batch, now, results, keyOf);
    }
    return results;
  }

  private async upsertBatchChunk(
    batch: { input: UpsertCaseInput; index: number }[],
    now: string,
    results: (UpsertedCase | null)[],
    keyOf: (i: Pick<UpsertCaseInput, "subjectId" | "measureId" | "evaluationPeriod">) => string,
  ): Promise<void> {
    // 1. One pre-read for every key in the chunk. `unnest` keeps this to three bind parameters
    //    whatever the chunk size, and the UNIQUE (employee_id, measure_id, evaluation_period) index
    //    is what it joins on.
    const { rows: existingRows } = await this.pool.query<CaseRow>(
      `SELECT ${COLS} FROM ${T} c
         JOIN unnest($1::text[], $2::text[], $3::text[]) AS k(e, m, p)
           ON c.employee_id = k.e AND c.measure_id = k.m AND c.evaluation_period = k.p`,
      [batch.map((b) => b.input.subjectId), batch.map((b) => b.input.measureId), batch.map((b) => b.input.evaluationPeriod)],
    );
    const existingByKey = new Map(existingRows.map((r) => [keyOf({ subjectId: r.employee_id, measureId: r.measure_id, evaluationPeriod: r.evaluation_period }), r]));

    // 2. Plan every row in memory — the pure functions, unchanged.
    interface Planned {
      index: number;
      input: UpsertCaseInput;
      existing: CaseRow | null;
      plan: ReturnType<typeof planCaseUpsert>;
      action: ReturnType<typeof planNextAction>;
      priority: string;
    }
    const toInsert: Planned[] = [];
    const toUpdate: Planned[] = [];
    for (const { input, index } of batch) {
      const existing = existingByKey.get(keyOf(input)) ?? null;
      const plan = planCaseUpsert(
        existing ? { status: existing.status, currentOutcomeStatus: existing.current_outcome_status, closedBy: existing.closed_by } : null,
        input.outcomeStatus,
        now,
        { outOfPopulation: input.outOfPopulation },
      );
      if (plan.op === "noop") continue; // stays null in `results`, exactly as the per-row call returns
      const action = planNextAction(
        existing
          ? { nextAction: existing.next_action, nextActionSource: existing.next_action_source, currentOutcomeStatus: existing.current_outcome_status }
          : null,
        nextActionFor(input.outcomeStatus, input.measureId, input.evidence),
        input.outcomeStatus,
      );
      const planned: Planned = { index, input, existing, plan, action, priority: priorityFor(input.outcomeStatus) };
      (plan.op === "insert" ? toInsert : toUpdate).push(planned);
    }

    // 3. One multi-row INSERT. `DO NOTHING` rather than `DO UPDATE`: a key a concurrent writer already
    //    created must be re-planned as an update against the row THEY wrote, not overwritten blind.
    const inserted = new Set<string>();
    if (toInsert.length > 0) {
      // `now` is $1, pushed BEFORE the rows: `created_at` and `updated_at` share it on every tuple, and
      // a placeholder computed from a moving `binds.length` inside the loop would point at a different
      // (later) row's parameter for every row after the first.
      const binds: unknown[] = [now];
      const tuples = toInsert.map((p) => {
        const b = binds.length;
        binds.push(
          crypto.randomUUID(), p.input.subjectId, p.input.measureId, p.input.evaluationPeriod,
          p.plan.status!, p.priority, p.action.nextAction, p.action.source,
          p.input.outcomeStatus, p.input.runId, p.plan.closedAt ?? null, p.plan.closedReason ?? null, p.plan.closedBy ?? null,
        );
        return `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, NULL, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}::uuid, $1::timestamptz, $1::timestamptz, $${b + 11}::timestamptz, $${b + 12}, $${b + 13})`;
      });
      const { rows } = await this.pool.query<CaseRow>(
        `INSERT INTO ${T}
           (id, employee_id, measure_id, evaluation_period, status, priority, assignee,
            next_action, next_action_source, current_outcome_status, last_run_id, created_at, updated_at, closed_at, closed_reason, closed_by)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (employee_id, measure_id, evaluation_period) DO NOTHING
         RETURNING ${COLS}`,
        binds,
      );
      const byKey = new Map(rows.map((r) => [keyOf({ subjectId: r.employee_id, measureId: r.measure_id, evaluationPeriod: r.evaluation_period }), r]));
      for (const p of toInsert) {
        const row = byKey.get(keyOf(p.input));
        if (row) {
          inserted.add(keyOf(p.input));
          results[p.index] = { ...toRecord(row), disposition: p.plan.disposition! };
        }
      }
    }

    // 4. One set-based UPDATE carrying the compare-and-set. The predicate compares the `next_action`
    //    and `next_action_source` we READ in step 1; a row an operator moved in between matches
    //    nothing and is left for the per-row path, which is precisely ADR-076 d2.
    const updateWinners = new Set<string>();
    if (toUpdate.length > 0) {
      const binds: unknown[] = [];
      const tuples = toUpdate.map((p, i) => {
        const b = binds.length;
        binds.push(
          p.input.subjectId, p.input.measureId, p.input.evaluationPeriod,
          p.plan.status!, p.priority, p.action.nextAction, p.action.source, p.input.outcomeStatus,
          p.plan.closedAt ?? null, p.plan.closedReason ?? null, p.plan.closedBy ?? null,
          p.existing!.next_action, p.existing!.next_action_source,
          // PER ROW, never hoisted. `last_run_id` is the evidence pin §6.5 relies on to survive
          // outcome compaction, and `countByLastRun` is a run's own case count — stamping the batch's
          // first runId on every row silently pins cases to a run that did not produce them. The
          // pipeline happens to pass one runId per chunk today, so this was latent; it is also
          // invisible to the SQLite floor, which loops and is therefore correct by construction.
          p.input.runId,
        );
        // Casts on the FIRST tuple only: Postgres infers `unknown` for bare parameters in a VALUES
        // list used as a FROM item, and `IS NOT DISTINCT FROM` against `unknown` does not resolve.
        const c =
          i === 0
            ? ["::text", "::text", "::text", "::text", "::text", "::text", "::text", "::text", "::timestamptz", "::text", "::text", "::text", "::text", "::uuid"]
            : new Array(14).fill("");
        return `(${c.map((cast, j) => `$${b + j + 1}${cast}`).join(", ")})`;
      });
      const nowParam = binds.push(now);
      const { rows } = await this.pool.query<CaseRow>(
        `UPDATE ${T} c SET
            status = v.status, priority = v.priority,
            next_action = v.next_action, next_action_source = v.next_action_source,
            current_outcome_status = v.current_outcome_status,
            last_run_id = v.last_run_id, updated_at = $${nowParam},
            closed_at = v.closed_at, closed_reason = v.closed_reason, closed_by = v.closed_by
          FROM (VALUES ${tuples.join(", ")}) AS v(
            employee_id, measure_id, evaluation_period,
            status, priority, next_action, next_action_source, current_outcome_status,
            closed_at, closed_reason, closed_by, expected_next_action, expected_next_action_source,
            last_run_id)
          WHERE c.employee_id = v.employee_id AND c.measure_id = v.measure_id AND c.evaluation_period = v.evaluation_period
            AND c.next_action IS NOT DISTINCT FROM v.expected_next_action
            AND c.next_action_source IS NOT DISTINCT FROM v.expected_next_action_source
          RETURNING ${COLS_C}`,
        binds,
      );
      const byKey = new Map(rows.map((r) => [keyOf({ subjectId: r.employee_id, measureId: r.measure_id, evaluationPeriod: r.evaluation_period }), r]));
      for (const p of toUpdate) {
        const row = byKey.get(keyOf(p.input));
        if (!row) continue; // lost the CAS, or the row vanished — per-row path below
        updateWinners.add(keyOf(p.input));
        // ADR-074 d13, compared against what was WRITTEN, exactly as the per-row path does.
        const disposition =
          p.plan.disposition === "UNCHANGED" && p.existing!.next_action !== row.next_action ? "UPDATED" : p.plan.disposition!;
        results[p.index] = { ...toRecord(row), disposition };
      }
    }

    // 5. The stragglers, one at a time, through the proven path: lost an insert race, or lost the CAS.
    //    On a nightly this is the handful of cases an operator touched while the run was going.
    const losers = [
      ...toInsert.filter((p) => !inserted.has(keyOf(p.input))),
      ...toUpdate.filter((p) => !updateWinners.has(keyOf(p.input))),
    ];
    for (const p of losers) results[p.index] = await this.upsertFromOutcome(p.input);
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
    // The operator surface: writing an action here transfers ownership (see the SQLite floor).
    if (patch.nextAction !== undefined) {
      sets.push(`next_action = $${binds.push(patch.nextAction)}`);
      sets.push(`next_action_source = $${binds.push(patch.nextActionSource ?? "OPERATOR")}`);
    } else if (patch.nextActionSource !== undefined) {
      sets.push(`next_action_source = $${binds.push(patch.nextActionSource)}`);
    }
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
    if (query.employeeId) {
      where.push(`employee_id = $${binds.length + 1}`);
      binds.push(query.employeeId);
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
