/**
 * Postgres ceiling implementation of the QualitySnapshotStore contract (#E16). Idempotent upsert via
 * ON CONFLICT (measure_id, period, scope_level, scope_id) DO UPDATE (last write wins). Schema-qualified
 * to workwell_spike. Counts only; never decides compliance (ADR-008).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type {
  QualityScopeLevel,
  QualitySnapshotInput,
  QualitySnapshotQuery,
  QualitySnapshotRow,
  QualitySnapshotStore,
} from "../quality-snapshot-store.ts";

const S = SPIKE_SCHEMA;
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

interface SnapRow {
  id: string;
  measure_id: string;
  period: string;
  period_start: Date | string;
  period_end: Date | string;
  scope_level: string;
  scope_id: string;
  tenant_id: string | null;
  numerator: number | string;
  denominator: number | string;
  compliant: number | string;
  due_soon: number | string;
  overdue: number | string;
  missing_data: number | string;
  excluded: number | string;
  source_run_id: string | null;
  computed_at: Date | string;
}

function mapRow(r: SnapRow): QualitySnapshotRow {
  return {
    id: r.id,
    measureId: r.measure_id,
    period: r.period,
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
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
    computedAt: iso(r.computed_at),
  };
}

export class PgQualitySnapshotStore implements QualitySnapshotStore {
  constructor(private readonly pool: PgPool) {}

  async upsertSnapshots(inputs: QualitySnapshotInput[]): Promise<void> {
    if (inputs.length === 0) return;
    // Chunked multi-row upsert (mirrors OutcomeStore.recordOutcomes' Neon batching discipline): a single
    // ALL_PROGRAMS materialization emits ~14 measures × ~265 scale-tenant rows ≈ 4k rows — one INSERT per
    // row would be ~4k sequential Neon round-trips. 17 cols/row × 100 rows = 1700 params per statement,
    // well under Postgres's 65535 bind-param limit. buildSnapshotRows emits one row per (measure, scope)
    // and materializeRun spans DISTINCT measures, so a chunk never holds a duplicate ON CONFLICT key
    // (which Postgres rejects: "ON CONFLICT DO UPDATE command cannot affect row a second time").
    const COLS = 17;
    const CHUNK = 100;
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const slice = inputs.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const tuples = slice.map((s, r) => {
        const o = r * COLS;
        params.push(
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
        );
        return `(${Array.from({ length: COLS }, (_, c) => `$${o + c + 1}`).join(", ")})`;
      });
      await this.pool.query(
        `INSERT INTO ${S}.quality_snapshots
           (id, measure_id, period, period_start, period_end, scope_level, scope_id, tenant_id,
            numerator, denominator, compliant, due_soon, overdue, missing_data, excluded, source_run_id, computed_at)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (measure_id, period, scope_level, scope_id) DO UPDATE SET
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end,
           tenant_id = EXCLUDED.tenant_id,
           numerator = EXCLUDED.numerator,
           denominator = EXCLUDED.denominator,
           compliant = EXCLUDED.compliant,
           due_soon = EXCLUDED.due_soon,
           overdue = EXCLUDED.overdue,
           missing_data = EXCLUDED.missing_data,
           excluded = EXCLUDED.excluded,
           source_run_id = EXCLUDED.source_run_id,
           computed_at = EXCLUDED.computed_at`,
        params,
      );
    }
  }

  async querySnapshots(query: QualitySnapshotQuery): Promise<QualitySnapshotRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, op: string, val: unknown): void => {
      params.push(val);
      where.push(`${col} ${op} $${params.length}`);
    };
    if (query.measureId) add("measure_id", "=", query.measureId);
    if (query.scopeLevel) add("scope_level", "=", query.scopeLevel);
    if (query.scopeId) add("scope_id", "=", query.scopeId);
    if (query.tenantId) add("tenant_id", "=", query.tenantId);
    if (query.from) add("period", ">=", query.from);
    if (query.to) add("period", "<=", query.to);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await this.pool.query<SnapRow>(
      `SELECT * FROM ${S}.quality_snapshots ${clause} ORDER BY period ASC, scope_id ASC`,
      params,
    );
    return rows.map(mapRow);
  }
}
