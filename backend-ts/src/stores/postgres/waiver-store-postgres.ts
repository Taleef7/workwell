/**
 * Postgres-ceiling implementation of the WaiverStore contract (#108 admin write CRUD — waivers).
 * Schema-qualified to the isolated `workwell_spike` schema; `active` is BOOLEAN. Ordering matches
 * Java: active DESC, expires_at ASC NULLS LAST, granted_at DESC.
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { InsertWaiverInput, WaiverQuery, WaiverRow, WaiverStore } from "../waiver-store.ts";

interface Row {
  id: string;
  employee_external_id: string;
  measure_id: string;
  measure_version_id: string;
  exclusion_reason: string;
  granted_by: string;
  granted_at: Date | string;
  expires_at: Date | string | null;
  notes: string | null;
  active: boolean;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : v);

const toRow = (r: Row): WaiverRow => ({
  id: r.id,
  employeeExternalId: r.employee_external_id,
  measureId: r.measure_id,
  measureVersionId: r.measure_version_id,
  exclusionReason: r.exclusion_reason,
  grantedBy: r.granted_by,
  grantedAt: iso(r.granted_at)!,
  expiresAt: iso(r.expires_at),
  notes: r.notes,
  active: r.active,
});

const COLS =
  "id, employee_external_id, measure_id, measure_version_id, exclusion_reason, granted_by, granted_at, expires_at, notes, active";
const ORDER = "ORDER BY active DESC, expires_at ASC NULLS LAST, granted_at DESC";

export class PgWaiverStore implements WaiverStore {
  constructor(private readonly pool: PgPool) {}

  async insert(input: InsertWaiverInput): Promise<WaiverRow> {
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.waivers (id, employee_external_id, measure_id, measure_version_id, exclusion_reason, granted_by, granted_at, expires_at, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)`,
      [
        input.id,
        input.employeeExternalId,
        input.measureId,
        input.measureVersionId,
        input.exclusionReason,
        input.grantedBy,
        input.expiresAt,
        input.notes,
        input.active,
      ],
    );
    return (await this.getById(input.id))!;
  }

  async list(query: WaiverQuery): Promise<WaiverRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (query.measureId) {
      args.push(query.measureId);
      where.push(`measure_id = $${args.length}`);
    }
    if (query.active != null) {
      args.push(query.active);
      where.push(`active = $${args.length}`);
    }
    if (query.expiresAfter) {
      args.push(query.expiresAfter);
      where.push(`expires_at >= $${args.length}`);
    }
    if (query.expiresBefore) {
      args.push(query.expiresBefore);
      where.push(`expires_at <= $${args.length}`);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM ${SPIKE_SCHEMA}.waivers${clause} ${ORDER}`, args);
    return rows.map(toRow);
  }

  async getById(id: string): Promise<WaiverRow | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM ${SPIKE_SCHEMA}.waivers WHERE id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }
}
