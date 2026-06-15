/**
 * SQLite/D1 floor implementation of the WaiverStore contract (#108 admin write CRUD — waivers).
 * `active` is INTEGER 0/1; ordering matches Java (active DESC, expires_at ASC NULLS LAST, granted_at DESC).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { InsertWaiverInput, WaiverQuery, WaiverRow, WaiverStore } from "../waiver-store.ts";

interface Row {
  id: string;
  employee_external_id: string;
  measure_id: string;
  measure_version_id: string;
  exclusion_reason: string;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  notes: string | null;
  active: number;
}

const toRow = (r: Row): WaiverRow => ({
  id: r.id,
  employeeExternalId: r.employee_external_id,
  measureId: r.measure_id,
  measureVersionId: r.measure_version_id,
  exclusionReason: r.exclusion_reason,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
  expiresAt: r.expires_at,
  notes: r.notes,
  active: Number(r.active) === 1,
});

const SELECT =
  "SELECT id, employee_external_id, measure_id, measure_version_id, exclusion_reason, granted_by, granted_at, expires_at, notes, active FROM waivers";
// active DESC, then expires_at ASC with NULLs last (SQLite sorts NULL first on ASC → guard), then granted_at DESC.
const ORDER = "ORDER BY active DESC, (expires_at IS NULL) ASC, expires_at ASC, granted_at DESC";

export class SqliteWaiverStore implements WaiverStore {
  constructor(private readonly db: CloudDatabase) {}

  async insert(input: InsertWaiverInput): Promise<WaiverRow> {
    const grantedAt = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO waivers (id, employee_external_id, measure_id, measure_version_id, exclusion_reason, granted_by, granted_at, expires_at, notes, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.employeeExternalId,
        input.measureId,
        input.measureVersionId,
        input.exclusionReason,
        input.grantedBy,
        grantedAt,
        input.expiresAt,
        input.notes,
        input.active ? 1 : 0,
      )
      .run();
    return (await this.getById(input.id))!;
  }

  async list(query: WaiverQuery): Promise<WaiverRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (query.measureId) {
      where.push("measure_id = ?");
      args.push(query.measureId);
    }
    if (query.active != null) {
      where.push("active = ?");
      args.push(query.active ? 1 : 0);
    }
    if (query.expiresAfter) {
      where.push("expires_at >= ?");
      args.push(query.expiresAfter);
    }
    if (query.expiresBefore) {
      where.push("expires_at <= ?");
      args.push(query.expiresBefore);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const { results } = await this.db.prepare(`${SELECT}${clause} ${ORDER}`).bind(...args).all<Row>();
    return (results ?? []).map(toRow);
  }

  async getById(id: string): Promise<WaiverRow | null> {
    const row = await this.db.prepare(`${SELECT} WHERE id = ?`).bind(id).first<Row>();
    return row ? toRow(row) : null;
  }
}
