/**
 * Postgres ceiling adapter for `PanelStore` (MM-2 PR 2, ADR-080). Upsert via ON CONFLICT on the
 * provider_id primary key DO UPDATE, keeping `created_by`/`created_at` — who first mapped a panel is
 * a different fact from who owns it now. Schema-qualified to workwell_spike.
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { PanelAssignment, PanelStore, UpsertPanelAssignmentInput } from "../panel-store.ts";

const S = SPIKE_SCHEMA;
const COLS = "provider_id, assignee, created_by, created_at, updated_at";
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

interface Row {
  provider_id: string;
  assignee: string;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toAssignment = (r: Row): PanelAssignment => ({
  providerId: r.provider_id,
  assignee: r.assignee,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export class PgPanelStore implements PanelStore {
  constructor(private readonly pool: PgPool) {}

  async listAll(): Promise<PanelAssignment[]> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM ${S}.panel_assignments ORDER BY provider_id ASC`);
    return rows.map(toAssignment);
  }

  async getPanelAssignment(providerId: string): Promise<PanelAssignment | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM ${S}.panel_assignments WHERE provider_id = $1`, [providerId]);
    return rows[0] ? toAssignment(rows[0]) : null;
  }

  async upsertPanelAssignment(input: UpsertPanelAssignmentInput): Promise<PanelAssignment> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO ${S}.panel_assignments (provider_id, assignee, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)
       ON CONFLICT (provider_id) DO UPDATE SET assignee = $2, updated_at = $4::timestamptz
       RETURNING ${COLS}`,
      [input.providerId, input.assignee, input.actor, input.now],
    );
    return toAssignment(rows[0]!);
  }

  async removePanelAssignment(providerId: string): Promise<PanelAssignment | null> {
    const { rows } = await this.pool.query<Row>(
      `DELETE FROM ${S}.panel_assignments WHERE provider_id = $1 RETURNING ${COLS}`,
      [providerId],
    );
    return rows[0] ? toAssignment(rows[0]) : null;
  }
}
