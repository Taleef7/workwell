/**
 * Postgres-ceiling implementation of the MeasureStore contract (#107 authoring). Same
 * contract as the SQLite floor; tags + spec live in native JSONB. Schema-qualified to the
 * isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { MeasureSpec } from "../../measure/measure-catalog.ts";
import type { CreateMeasureInput, MeasureRecord, MeasureStore, SeedMeasureInput, StatusChange } from "../measure-store.ts";

interface JoinRow {
  measure_id: string;
  name: string;
  policy_ref: string | null;
  owner: string | null;
  tags: unknown;
  version_id: string;
  version: string;
  status: string;
  spec_json: unknown;
  cql_text: string;
  compile_status: string;
  change_summary: string | null;
  approved_by: string | null;
  activated_at: Date | string | null;
  version_created_at: Date | string;
  updated_at: Date | string;
}

const EMPTY_SPEC: MeasureSpec = {
  description: "",
  eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
  exclusions: [],
  complianceWindow: "",
  requiredDataElements: [],
  testFixtures: [],
};

const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : v);

const toRecord = (r: JoinRow): MeasureRecord => ({
  measureId: r.measure_id,
  name: r.name,
  policyRef: r.policy_ref ?? "",
  owner: r.owner ?? "",
  tags: (r.tags as string[]) ?? [],
  versionId: r.version_id,
  version: r.version,
  status: r.status,
  spec: r.spec_json as MeasureSpec,
  cqlText: r.cql_text,
  compileStatus: r.compile_status,
  changeSummary: r.change_summary,
  approvedBy: r.approved_by,
  activatedAt: iso(r.activated_at),
  createdAt: iso(r.version_created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const M = `${SPIKE_SCHEMA}.measures`;
const V = `${SPIKE_SCHEMA}.measure_versions`;
const SELECT = `SELECT m.id AS measure_id, m.name, m.policy_ref, m.owner, m.tags, m.updated_at,
    mv.id AS version_id, mv.version, mv.status, mv.spec_json, mv.cql_text, mv.compile_status,
    mv.change_summary, mv.approved_by, mv.activated_at, mv.created_at AS version_created_at
  FROM ${M} m JOIN ${V} mv ON mv.measure_id = m.id`;
const LATEST = `mv.created_at = (SELECT MAX(v2.created_at) FROM ${V} v2 WHERE v2.measure_id = m.id)`;

export class PgMeasureStore implements MeasureStore {
  constructor(private readonly pool: PgPool) {}

  async isEmpty(): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${M}`);
    return Number(rows[0]?.n ?? 0) === 0;
  }

  async seedMeasure(i: SeedMeasureInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${M} (id, name, policy_ref, owner, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
      [i.measureId, i.name, i.policyRef, i.owner, JSON.stringify(i.tags), i.createdAt],
    );
    await this.pool.query(
      `INSERT INTO ${V} (id, measure_id, version, status, spec_json, cql_text, compile_status, change_summary, approved_by, activated_at, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, NULL, $9, $10)`,
      [i.versionId, i.measureId, i.version, i.status, JSON.stringify(i.spec), i.cqlText, i.compileStatus, i.changeSummary, i.status === "Active" ? i.createdAt : null, i.createdAt],
    );
  }

  async listLatest(): Promise<MeasureRecord[]> {
    const { rows } = await this.pool.query<JoinRow>(`${SELECT} WHERE ${LATEST}`);
    return rows.map(toRecord);
  }

  async getLatest(measureId: string): Promise<MeasureRecord | null> {
    const { rows } = await this.pool.query<JoinRow>(`${SELECT} WHERE m.id = $1 AND ${LATEST}`, [measureId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listVersions(measureId: string): Promise<MeasureRecord[]> {
    const { rows } = await this.pool.query<JoinRow>(`${SELECT} WHERE m.id = $1 ORDER BY mv.created_at DESC`, [measureId]);
    return rows.map(toRecord);
  }

  async createMeasure(input: CreateMeasureInput): Promise<MeasureRecord> {
    const measureId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await this.seedMeasure({
      measureId,
      name: input.name,
      policyRef: input.policyRef,
      owner: input.owner,
      tags: [],
      versionId,
      version: "v1.0",
      status: "Draft",
      spec: EMPTY_SPEC,
      cqlText: "",
      compileStatus: "ERROR",
      createdAt: new Date().toISOString(),
      changeSummary: "Initial draft",
    });
    return (await this.getLatest(measureId))!;
  }

  async setVersionStatus(measureId: string, versionId: string, change: StatusChange): Promise<MeasureRecord | null> {
    const now = new Date().toISOString();
    const sets = ["status = $1"];
    const binds: unknown[] = [change.status];
    if (change.approvedBy !== undefined) sets.push(`approved_by = $${binds.push(change.approvedBy)}`);
    if (change.activate) sets.push(`activated_at = $${binds.push(now)}`);
    await this.pool.query(`UPDATE ${V} SET ${sets.join(", ")} WHERE id = $${binds.push(versionId)}`, binds);
    await this.pool.query(`UPDATE ${M} SET updated_at = $1 WHERE id = $2`, [now, measureId]);
    return this.getLatest(measureId);
  }

  private async latestVersionId(measureId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${V} WHERE measure_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [measureId],
    );
    return rows[0]?.id ?? null;
  }

  async updateSpec(measureId: string, spec: MeasureSpec, policyRef?: string): Promise<MeasureRecord | null> {
    const versionId = await this.latestVersionId(measureId);
    if (!versionId) return null;
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE ${V} SET spec_json = $1::jsonb WHERE id = $2`, [JSON.stringify(spec), versionId]);
    if (policyRef !== undefined) {
      await this.pool.query(`UPDATE ${M} SET policy_ref = $1, updated_at = $2 WHERE id = $3`, [policyRef, now, measureId]);
    } else {
      await this.pool.query(`UPDATE ${M} SET updated_at = $1 WHERE id = $2`, [now, measureId]);
    }
    return this.getLatest(measureId);
  }

  async updateCql(measureId: string, cqlText: string, compileStatus?: string): Promise<MeasureRecord | null> {
    const versionId = await this.latestVersionId(measureId);
    if (!versionId) return null;
    const now = new Date().toISOString();
    if (compileStatus !== undefined) {
      await this.pool.query(`UPDATE ${V} SET cql_text = $1, compile_status = $2 WHERE id = $3`, [cqlText, compileStatus, versionId]);
    } else {
      await this.pool.query(`UPDATE ${V} SET cql_text = $1 WHERE id = $2`, [cqlText, versionId]);
    }
    await this.pool.query(`UPDATE ${M} SET updated_at = $1 WHERE id = $2`, [now, measureId]);
    return this.getLatest(measureId);
  }
}
