/**
 * SQLite floor adapter for `PanelStore` (MM-2 PR 2, ADR-080). `ON CONFLICT(provider_id) DO UPDATE`
 * rather than `INSERT OR REPLACE`, because REPLACE deletes the row and re-inserts it — which would
 * silently drop `created_by`/`created_at`, the record of who first mapped the panel.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { PanelAssignment, PanelStore, UpsertPanelAssignmentInput } from "../panel-store.ts";

const COLS = "provider_id, assignee, created_by, created_at, updated_at";

interface Row {
  provider_id: string;
  assignee: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const toAssignment = (r: Row): PanelAssignment => ({
  providerId: r.provider_id,
  assignee: r.assignee,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqlitePanelStore implements PanelStore {
  constructor(private readonly db: CloudDatabase) {}

  async listAll(): Promise<PanelAssignment[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM panel_assignments ORDER BY provider_id ASC`)
      .all<Row>();
    return (results ?? []).map(toAssignment);
  }

  async getPanelAssignment(providerId: string): Promise<PanelAssignment | null> {
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM panel_assignments WHERE provider_id = ?`)
      .bind(providerId)
      .all<Row>();
    const row = (results ?? [])[0];
    return row ? toAssignment(row) : null;
  }

  async upsertPanelAssignment(input: UpsertPanelAssignmentInput): Promise<PanelAssignment> {
    await this.db
      .prepare(
        `INSERT INTO panel_assignments (provider_id, assignee, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET assignee = excluded.assignee, updated_at = excluded.updated_at`,
      )
      .bind(input.providerId, input.assignee, input.actor, input.now, input.now)
      .run();
    // Read back rather than construct: on an update the row keeps the ORIGINAL created_by/created_at,
    // which the input does not carry, so returning the input would report a different row than exists.
    const stored = await this.getPanelAssignment(input.providerId);
    return stored!;
  }

  async removePanelAssignment(providerId: string): Promise<PanelAssignment | null> {
    // Read-then-delete: the floor's `run()` reports no rows, and the caller audits the assignee it
    // removed — a fact that cannot be recovered once the row is gone.
    const existing = await this.getPanelAssignment(providerId);
    if (!existing) return null;
    await this.db.prepare(`DELETE FROM panel_assignments WHERE provider_id = ?`).bind(providerId).run();
    return existing;
  }
}
