/**
 * Postgres ceiling implementation of the SegmentStore contract (#183 E11.3). rule_json is JSONB,
 * enabled is BOOLEAN; child rows cascade on delete (FK ON DELETE CASCADE). Schema-qualified to
 * workwell_spike (SPIKE_SCHEMA).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type {
  CreateSegmentInput, HydratedSegment, SegmentOverride, SegmentRule, SegmentStore, UpdateSegmentPatch,
} from "../segment-store.ts";

const S = SPIKE_SCHEMA;

interface SegRow {
  id: string; name: string; description: string | null; enabled: boolean;
  rule_json: unknown; created_by: string | null; created_at: Date | string; updated_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function parseRule(raw: unknown): SegmentRule {
  const r = (raw ?? {}) as Partial<SegmentRule>;
  return { match: r.match === "ALL" ? "ALL" : "ANY", conditions: Array.isArray(r.conditions) ? r.conditions : [] };
}

export class PgSegmentStore implements SegmentStore {
  constructor(private readonly pool: PgPool) {}

  private async hydrate(row: SegRow): Promise<HydratedSegment> {
    const ms = await this.pool.query<{ measure_id: string }>(`SELECT measure_id FROM ${S}.segment_measures WHERE segment_id = $1 ORDER BY measure_id ASC`, [row.id]);
    const ov = await this.pool.query<{ external_id: string; mode: string }>(`SELECT external_id, mode FROM ${S}.segment_overrides WHERE segment_id = $1 ORDER BY external_id ASC`, [row.id]);
    return {
      id: row.id, name: row.name, description: row.description ?? "", enabled: row.enabled === true,
      rule: parseRule(row.rule_json),
      measureIds: ms.rows.map((r) => r.measure_id),
      overrides: ov.rows.map((r) => ({ externalId: r.external_id, mode: r.mode === "INCLUDE" ? "INCLUDE" : "EXCLUDE" } as SegmentOverride)),
      createdBy: row.created_by ?? "", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
  }

  async listSegments(): Promise<HydratedSegment[]> {
    const { rows } = await this.pool.query<SegRow>(`SELECT * FROM ${S}.segments ORDER BY name ASC`);
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async getSegment(id: string): Promise<HydratedSegment | null> {
    const { rows } = await this.pool.query<SegRow>(`SELECT * FROM ${S}.segments WHERE id = $1`, [id]);
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  async createSegment(input: CreateSegmentInput): Promise<HydratedSegment> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO ${S}.segments (id, name, description, enabled, rule_json, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [id, input.name, input.description ?? null, input.enabled !== false, JSON.stringify(input.rule), null, now, now],
    );
    await this.setMeasures(id, input.measureIds);
    await this.setOverrides(id, input.overrides ?? []);
    return (await this.getSegment(id))!;
  }

  async updateSegment(id: string, patch: UpdateSegmentPatch): Promise<HydratedSegment | null> {
    const { rows } = await this.pool.query<SegRow>(`SELECT * FROM ${S}.segments WHERE id = $1`, [id]);
    const existing = rows[0];
    if (!existing) return null;
    const name = patch.name ?? existing.name;
    const description = patch.description !== undefined ? patch.description : existing.description;
    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    // Preserve the stored rule verbatim when it isn't being changed (Fable L12) — the prior
    // `parseRule` round-trip could silently drop a schema-growing rule field on the ceiling only,
    // diverging from the SQLite floor (which preserves it). Both now keep the untouched JSON as-is.
    const ruleJson = patch.rule !== undefined ? JSON.stringify(patch.rule) : JSON.stringify(existing.rule_json);
    await this.pool.query(
      `UPDATE ${S}.segments SET name = $1, description = $2, enabled = $3, rule_json = $4::jsonb, updated_at = $5 WHERE id = $6`,
      [name, description, enabled, ruleJson, new Date().toISOString(), id],
    );
    return this.getSegment(id);
  }

  async deleteSegment(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${S}.segments WHERE id = $1`, [id]); // children cascade
  }

  async setMeasures(id: string, measureIds: string[]): Promise<void> {
    await this.pool.query(`DELETE FROM ${S}.segment_measures WHERE segment_id = $1`, [id]);
    for (const m of [...new Set(measureIds)]) {
      await this.pool.query(`INSERT INTO ${S}.segment_measures (segment_id, measure_id) VALUES ($1, $2)`, [id, m]);
    }
  }

  async setOverrides(id: string, overrides: SegmentOverride[]): Promise<void> {
    await this.pool.query(`DELETE FROM ${S}.segment_overrides WHERE segment_id = $1`, [id]);
    const seen = new Set<string>();
    for (const o of overrides) {
      if (seen.has(o.externalId)) continue;
      seen.add(o.externalId);
      await this.pool.query(`INSERT INTO ${S}.segment_overrides (segment_id, external_id, mode) VALUES ($1, $2, $3)`, [id, o.externalId, o.mode]);
    }
  }
}
