/**
 * SQLite/D1 floor implementation of the SegmentStore contract (#183 E11.3). rule_json is JSON TEXT,
 * enabled is INTEGER 0/1. Measures + overrides live in child tables; deleteSegment removes them
 * explicitly (the floor does not enable PRAGMA foreign_keys).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type {
  CreateSegmentInput, HydratedSegment, SegmentOverride, SegmentRule, SegmentStore, UpdateSegmentPatch,
} from "../segment-store.ts";

interface SegRow {
  id: string; name: string; description: string | null; enabled: number;
  rule_json: string; created_by: string | null; created_at: string; updated_at: string;
}

function parseRule(json: string | null): SegmentRule {
  if (!json) return { match: "ANY", conditions: [] };
  try {
    const raw = JSON.parse(json) as Partial<SegmentRule>;
    return { match: raw.match === "ALL" ? "ALL" : "ANY", conditions: Array.isArray(raw.conditions) ? raw.conditions : [] };
  } catch {
    return { match: "ANY", conditions: [] };
  }
}

export class SqliteSegmentStore implements SegmentStore {
  constructor(private readonly db: CloudDatabase) {}

  private async hydrate(row: SegRow): Promise<HydratedSegment> {
    const ms = await this.db.prepare("SELECT measure_id FROM segment_measures WHERE segment_id = ? ORDER BY measure_id ASC").bind(row.id).all<{ measure_id: string }>();
    const ov = await this.db.prepare("SELECT external_id, mode FROM segment_overrides WHERE segment_id = ? ORDER BY external_id ASC").bind(row.id).all<{ external_id: string; mode: string }>();
    return {
      id: row.id, name: row.name, description: row.description ?? "", enabled: Number(row.enabled) === 1,
      rule: parseRule(row.rule_json),
      measureIds: (ms.results ?? []).map((r) => r.measure_id),
      overrides: (ov.results ?? []).map((r) => ({ externalId: r.external_id, mode: r.mode === "INCLUDE" ? "INCLUDE" : "EXCLUDE" } as SegmentOverride)),
      createdBy: row.created_by ?? "", createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async listSegments(): Promise<HydratedSegment[]> {
    const { results } = await this.db.prepare("SELECT * FROM segments ORDER BY name ASC").all<SegRow>();
    return Promise.all((results ?? []).map((r) => this.hydrate(r)));
  }

  async getSegment(id: string): Promise<HydratedSegment | null> {
    const row = await this.db.prepare("SELECT * FROM segments WHERE id = ?").bind(id).first<SegRow>();
    return row ? this.hydrate(row) : null;
  }

  async createSegment(input: CreateSegmentInput): Promise<HydratedSegment> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare("INSERT INTO segments (id, name, description, enabled, rule_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.name, input.description ?? null, input.enabled === false ? 0 : 1, JSON.stringify(input.rule), null, now, now)
      .run();
    await this.setMeasures(id, input.measureIds);
    await this.setOverrides(id, input.overrides ?? []);
    return (await this.getSegment(id))!;
  }

  async updateSegment(id: string, patch: UpdateSegmentPatch): Promise<HydratedSegment | null> {
    const existing = await this.db.prepare("SELECT * FROM segments WHERE id = ?").bind(id).first<SegRow>();
    if (!existing) return null;
    const name = patch.name ?? existing.name;
    const description = patch.description !== undefined ? patch.description : existing.description;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
    const ruleJson = patch.rule !== undefined ? JSON.stringify(patch.rule) : existing.rule_json;
    await this.db
      .prepare("UPDATE segments SET name = ?, description = ?, enabled = ?, rule_json = ?, updated_at = ? WHERE id = ?")
      .bind(name, description, enabled, ruleJson, new Date().toISOString(), id)
      .run();
    return this.getSegment(id);
  }

  async deleteSegment(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM segment_measures WHERE segment_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM segment_overrides WHERE segment_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM segments WHERE id = ?").bind(id).run();
  }

  async setMeasures(id: string, measureIds: string[]): Promise<void> {
    await this.db.prepare("DELETE FROM segment_measures WHERE segment_id = ?").bind(id).run();
    for (const m of [...new Set(measureIds)]) {
      await this.db.prepare("INSERT INTO segment_measures (segment_id, measure_id) VALUES (?, ?)").bind(id, m).run();
    }
  }

  async setOverrides(id: string, overrides: SegmentOverride[]): Promise<void> {
    await this.db.prepare("DELETE FROM segment_overrides WHERE segment_id = ?").bind(id).run();
    const seen = new Set<string>();
    for (const o of overrides) {
      if (seen.has(o.externalId)) continue;
      seen.add(o.externalId);
      await this.db.prepare("INSERT INTO segment_overrides (segment_id, external_id, mode) VALUES (?, ?, ?)").bind(id, o.externalId, o.mode).run();
    }
  }
}
