/**
 * SQLite/D1 floor implementation of the QualitySnapshotStore contract (#E16). Idempotent upsert via
 * `INSERT OR REPLACE` on the UNIQUE (measure_id, period, scope_level, scope_id) key (last write wins) —
 * which also sidesteps the `excluded` ON CONFLICT pseudo-table clashing with the column literally named
 * `excluded`. Counts only; never decides compliance (ADR-008).
 *
 * Note: INSERT OR REPLACE delete+inserts on a UNIQUE conflict, so a re-materialized row gets a NEW `id`
 * — floor ids are NOT stable across re-materialization (the Pg ceiling's ON CONFLICT DO UPDATE keeps the
 * id). Snapshot ids are opaque; consumers (the PR-2 read API) must not assume floor id stability.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type {
  QualityScopeLevel,
  QualitySnapshotInput,
  QualitySnapshotQuery,
  QualitySnapshotRow,
  QualitySnapshotStore,
} from "../quality-snapshot-store.ts";

interface SnapRow {
  id: string;
  measure_id: string;
  period: string;
  period_start: string;
  period_end: string;
  scope_level: string;
  scope_id: string;
  tenant_id: string | null;
  numerator: number;
  denominator: number;
  compliant: number;
  due_soon: number;
  overdue: number;
  missing_data: number;
  excluded: number;
  source_run_id: string | null;
  computed_at: string;
}

function mapRow(r: SnapRow): QualitySnapshotRow {
  return {
    id: r.id,
    measureId: r.measure_id,
    period: r.period,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    scopeLevel: r.scope_level as QualityScopeLevel,
    scopeId: r.scope_id,
    tenantId: r.tenant_id ?? null,
    numerator: Number(r.numerator),
    denominator: Number(r.denominator),
    compliant: Number(r.compliant),
    dueSoon: Number(r.due_soon),
    overdue: Number(r.overdue),
    missingData: Number(r.missing_data),
    excluded: Number(r.excluded),
    sourceRunId: r.source_run_id ?? null,
    computedAt: r.computed_at,
  };
}

export class SqliteQualitySnapshotStore implements QualitySnapshotStore {
  constructor(private readonly db: CloudDatabase) {}

  async upsertSnapshots(inputs: QualitySnapshotInput[]): Promise<void> {
    for (const s of inputs) {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO quality_snapshots
             (id, measure_id, period, period_start, period_end, scope_level, scope_id, tenant_id,
              numerator, denominator, compliant, due_soon, overdue, missing_data, excluded, source_run_id, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          s.measureId,
          s.period,
          s.periodStart,
          s.periodEnd,
          s.scopeLevel,
          s.scopeId,
          s.tenantId,
          s.numerator,
          s.denominator,
          s.compliant,
          s.dueSoon,
          s.overdue,
          s.missingData,
          s.excluded,
          s.sourceRunId,
          s.computedAt,
        )
        .run();
    }
  }

  async querySnapshots(query: QualitySnapshotQuery): Promise<QualitySnapshotRow[]> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (query.measureId) {
      where.push("measure_id = ?");
      binds.push(query.measureId);
    }
    if (query.scopeLevel) {
      where.push("scope_level = ?");
      binds.push(query.scopeLevel);
    }
    if (query.scopeId) {
      where.push("scope_id = ?");
      binds.push(query.scopeId);
    }
    if (query.tenantId) {
      where.push("tenant_id = ?");
      binds.push(query.tenantId);
    }
    if (query.from) {
      where.push("period >= ?");
      binds.push(query.from);
    }
    if (query.to) {
      where.push("period <= ?");
      binds.push(query.to);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const stmt = this.db.prepare(`SELECT * FROM quality_snapshots ${clause} ORDER BY period ASC, scope_id ASC`);
    const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all<SnapRow>();
    return (results ?? []).map(mapRow);
  }
}
