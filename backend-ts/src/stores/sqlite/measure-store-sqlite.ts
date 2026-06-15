/**
 * SQLite/D1 floor implementation of the MeasureStore contract (#107 authoring).
 * tags + spec are JSON TEXT columns on the floor (TEXT[]/JSONB on the ceiling). The
 * denormalized MeasureRecord joins a measure to its latest (most recent created_at) version.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { MeasureSpec } from "../../measure/measure-catalog.ts";
import type { CreateMeasureInput, MeasureRecord, MeasureStore, SeedMeasureInput, StatusChange } from "../measure-store.ts";

interface JoinRow {
  measure_id: string;
  name: string;
  policy_ref: string | null;
  owner: string | null;
  tags: string;
  version_id: string;
  version: string;
  status: string;
  spec_json: string;
  cql_text: string;
  compile_status: string;
  change_summary: string | null;
  approved_by: string | null;
  activated_at: string | null;
  version_created_at: string;
  updated_at: string;
}

const EMPTY_SPEC: MeasureSpec = {
  description: "",
  eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
  exclusions: [],
  complianceWindow: "",
  requiredDataElements: [],
  testFixtures: [],
};

const toRecord = (r: JoinRow): MeasureRecord => ({
  measureId: r.measure_id,
  name: r.name,
  policyRef: r.policy_ref ?? "",
  owner: r.owner ?? "",
  tags: JSON.parse(r.tags) as string[],
  versionId: r.version_id,
  version: r.version,
  status: r.status,
  spec: JSON.parse(r.spec_json) as MeasureSpec,
  cqlText: r.cql_text,
  compileStatus: r.compile_status,
  changeSummary: r.change_summary,
  approvedBy: r.approved_by,
  activatedAt: r.activated_at,
  createdAt: r.version_created_at,
  updatedAt: r.updated_at,
});

const SELECT = `SELECT m.id AS measure_id, m.name, m.policy_ref, m.owner, m.tags, m.updated_at,
    mv.id AS version_id, mv.version, mv.status, mv.spec_json, mv.cql_text, mv.compile_status,
    mv.change_summary, mv.approved_by, mv.activated_at, mv.created_at AS version_created_at
  FROM measures m JOIN measure_versions mv ON mv.measure_id = m.id`;

// The latest version per measure: the row whose created_at is the max for that measure.
const LATEST_PREDICATE = `mv.created_at = (SELECT MAX(v2.created_at) FROM measure_versions v2 WHERE v2.measure_id = m.id)`;

export class SqliteMeasureStore implements MeasureStore {
  constructor(private readonly db: CloudDatabase) {}

  async isEmpty(): Promise<boolean> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM measures").first<{ n: number }>();
    return Number(row?.n ?? 0) === 0;
  }

  async seedMeasure(i: SeedMeasureInput): Promise<void> {
    await this.db
      .prepare("INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(i.measureId, i.name, i.policyRef, i.owner, JSON.stringify(i.tags), i.createdAt, i.createdAt)
      .run();
    await this.db
      .prepare(
        `INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text, compile_status, change_summary, approved_by, activated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(i.versionId, i.measureId, i.version, i.status, JSON.stringify(i.spec), i.cqlText, i.compileStatus, i.changeSummary, i.status === "Active" ? i.createdAt : null, i.createdAt)
      .run();
  }

  async listLatest(): Promise<MeasureRecord[]> {
    const { results } = await this.db.prepare(`${SELECT} WHERE ${LATEST_PREDICATE}`).all<JoinRow>();
    return (results ?? []).map(toRecord);
  }

  async getLatest(measureId: string): Promise<MeasureRecord | null> {
    const row = await this.db.prepare(`${SELECT} WHERE m.id = ? AND ${LATEST_PREDICATE}`).bind(measureId).first<JoinRow>();
    return row ? toRecord(row) : null;
  }

  async listVersions(measureId: string): Promise<MeasureRecord[]> {
    const { results } = await this.db
      .prepare(`${SELECT} WHERE m.id = ? ORDER BY mv.created_at DESC`)
      .bind(measureId)
      .all<JoinRow>();
    return (results ?? []).map(toRecord);
  }

  async createMeasure(input: CreateMeasureInput): Promise<MeasureRecord> {
    const measureId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const now = new Date().toISOString();
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
      createdAt: now,
      changeSummary: "Initial draft",
    });
    return (await this.getLatest(measureId))!;
  }

  async setVersionStatus(measureId: string, versionId: string, change: StatusChange): Promise<MeasureRecord | null> {
    const now = new Date().toISOString();
    const sets = ["status = ?"];
    const binds: unknown[] = [change.status];
    if (change.approvedBy !== undefined) (sets.push("approved_by = ?"), binds.push(change.approvedBy));
    if (change.activate) (sets.push("activated_at = ?"), binds.push(now));
    await this.db.prepare(`UPDATE measure_versions SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, versionId).run();
    await this.db.prepare("UPDATE measures SET updated_at = ? WHERE id = ?").bind(now, measureId).run();
    return this.getLatest(measureId);
  }

  // The latest version's id for a measure (max created_at) — the row Studio edits target.
  private async latestVersionId(measureId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT id FROM measure_versions WHERE measure_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(measureId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async updateSpec(measureId: string, spec: MeasureSpec, policyRef?: string): Promise<MeasureRecord | null> {
    const versionId = await this.latestVersionId(measureId);
    if (!versionId) return null;
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE measure_versions SET spec_json = ? WHERE id = ?").bind(JSON.stringify(spec), versionId).run();
    if (policyRef !== undefined) {
      await this.db.prepare("UPDATE measures SET policy_ref = ?, updated_at = ? WHERE id = ?").bind(policyRef, now, measureId).run();
    } else {
      await this.db.prepare("UPDATE measures SET updated_at = ? WHERE id = ?").bind(now, measureId).run();
    }
    return this.getLatest(measureId);
  }

  async updateCql(measureId: string, cqlText: string, compileStatus?: string): Promise<MeasureRecord | null> {
    const versionId = await this.latestVersionId(measureId);
    if (!versionId) return null;
    const now = new Date().toISOString();
    if (compileStatus !== undefined) {
      await this.db.prepare("UPDATE measure_versions SET cql_text = ?, compile_status = ? WHERE id = ?").bind(cqlText, compileStatus, versionId).run();
    } else {
      await this.db.prepare("UPDATE measure_versions SET cql_text = ? WHERE id = ?").bind(cqlText, versionId).run();
    }
    await this.db.prepare("UPDATE measures SET updated_at = ? WHERE id = ?").bind(now, measureId).run();
    return this.getLatest(measureId);
  }
}
