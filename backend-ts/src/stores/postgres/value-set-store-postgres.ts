/**
 * Postgres-ceiling implementation of the ValueSetStore contract (#108 value-set governance).
 * Schema-qualified to the isolated `workwell_spike` schema. codes_json is JSONB, code_systems
 * is text[]; ids are TEXT (matching the spike's TEXT measure ids — no uuid cast needed).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type {
  CodeEntry,
  CreateTerminologyMappingInput,
  SeedValueSetInput,
  TerminologyMappingRecord,
  ValueSetRecord,
  ValueSetStore,
} from "../value-set-store.ts";

interface VsRow {
  id: string;
  oid: string;
  name: string;
  version: string | null;
  codes_json: unknown;
  last_resolved_at: Date | string | null;
  canonical_url: string | null;
  code_systems: string[] | null;
  source: string | null;
  status: string;
  expansion_hash: string | null;
  resolution_status: string;
  resolution_error: string | null;
}

interface TmRow {
  id: string;
  local_code: string;
  local_display: string | null;
  local_system: string;
  standard_code: string;
  standard_display: string | null;
  standard_system: string;
  mapping_status: string;
  mapping_confidence: string | number | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  notes: string | null;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : v);

function parseCodes(value: unknown): CodeEntry[] {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return { code: String(o.code ?? ""), display: String(o.display ?? ""), system: String(o.system ?? "") };
  });
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

const toRecord = (r: VsRow): ValueSetRecord => ({
  id: r.id,
  oid: r.oid,
  name: r.name,
  version: r.version,
  lastResolvedAt: iso(r.last_resolved_at),
  canonicalUrl: r.canonical_url ?? "",
  source: r.source ?? "",
  governanceStatus: r.status,
  resolutionStatus: r.resolution_status,
  resolutionError: r.resolution_error ?? "",
  expansionHash: r.expansion_hash ?? "",
  codeSystems: r.code_systems ?? [],
  codes: parseCodes(r.codes_json),
});

const toTerminology = (r: TmRow): TerminologyMappingRecord => ({
  id: r.id,
  localCode: r.local_code,
  localDisplay: r.local_display,
  localSystem: r.local_system,
  standardCode: r.standard_code,
  standardDisplay: r.standard_display,
  standardSystem: r.standard_system,
  mappingStatus: r.mapping_status,
  mappingConfidence: r.mapping_confidence === null ? null : Number(r.mapping_confidence),
  reviewedBy: r.reviewed_by,
  reviewedAt: iso(r.reviewed_at),
  notes: r.notes,
});

const VS_COLS =
  "id, oid, name, version, codes_json, last_resolved_at, canonical_url, code_systems, source, status, expansion_hash, resolution_status, resolution_error";
const TM_COLS =
  "id, local_code, local_display, local_system, standard_code, standard_display, standard_system, mapping_status, mapping_confidence, reviewed_by, reviewed_at, notes";

export class PgValueSetStore implements ValueSetStore {
  constructor(private readonly pool: PgPool) {}

  async isEmpty(): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${SPIKE_SCHEMA}.value_sets`);
    return Number(rows[0]?.n ?? 0) === 0;
  }

  async seedValueSet(input: SeedValueSetInput): Promise<void> {
    const systems = [...new Set(input.codes.map((c) => c.system).filter(Boolean))];
    await this.pool.query(`DELETE FROM ${SPIKE_SCHEMA}.value_sets WHERE oid = $1 AND id <> $2`, [input.oid, input.id]);
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.value_sets
         (id, oid, name, version, codes_json, code_systems, source, status, resolution_status, last_resolved_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'WorkWell Demo', 'ACTIVE', 'RESOLVED', NOW())
       ON CONFLICT (id) DO UPDATE SET
         oid = EXCLUDED.oid, name = EXCLUDED.name, version = EXCLUDED.version,
         codes_json = EXCLUDED.codes_json, code_systems = EXCLUDED.code_systems,
         resolution_status = 'RESOLVED', last_resolved_at = NOW()`,
      [input.id, input.oid, input.name, input.version, JSON.stringify(input.codes), systems],
    );
  }

  async setCodes(id: string, codes: { code: string; display: string; system: string }[]): Promise<void> {
    const systems = [...new Set(codes.map((c) => c.system).filter(Boolean))];
    // Codes-only update — never touches status/version/resolution_status/last_resolved_at (preserves
    // operator-managed governance metadata, unlike seedValueSet's upsert).
    await this.pool.query(
      `UPDATE ${SPIKE_SCHEMA}.value_sets SET codes_json = $1::jsonb, code_systems = $2 WHERE id = $3`,
      [JSON.stringify(codes), systems, id],
    );
  }

  async link(measureVersionId: string, valueSetId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.measure_value_set_links (measure_version_id, value_set_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [measureVersionId, valueSetId],
    );
  }

  async unlink(measureVersionId: string, valueSetId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${SPIKE_SCHEMA}.measure_value_set_links WHERE measure_version_id = $1 AND value_set_id = $2`,
      [measureVersionId, valueSetId],
    );
  }

  async listAll(): Promise<ValueSetRecord[]> {
    const { rows } = await this.pool.query<VsRow>(`SELECT ${VS_COLS} FROM ${SPIKE_SCHEMA}.value_sets ORDER BY name ASC, oid ASC`);
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<ValueSetRecord | null> {
    const { rows } = await this.pool.query<VsRow>(`SELECT ${VS_COLS} FROM ${SPIKE_SCHEMA}.value_sets WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(oid: string, name: string, version: string | null): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.value_sets (id, oid, name, version, codes_json, code_systems, status, resolution_status, last_resolved_at)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, '{}', 'DRAFT', 'UNKNOWN', NOW())`,
      [id, oid, name, version && version.trim() !== "" ? version : "unspecified"],
    );
    return id;
  }

  async listByVersion(measureVersionId: string): Promise<ValueSetRecord[]> {
    const { rows } = await this.pool.query<VsRow>(
      `SELECT ${VS_COLS.split(", ").map((c) => `vs.${c}`).join(", ")}
       FROM ${SPIKE_SCHEMA}.measure_value_set_links l
       JOIN ${SPIKE_SCHEMA}.value_sets vs ON vs.id = l.value_set_id
       WHERE l.measure_version_id = $1
       ORDER BY vs.name ASC, vs.oid ASC`,
      [measureVersionId],
    );
    return rows.map(toRecord);
  }

  async affectedMeasures(valueSetIds: string[]): Promise<Array<{ measureId: string; measureName: string; version: string }>> {
    if (valueSetIds.length === 0) return [];
    const { rows } = await this.pool.query<{ measure_id: string; measure_name: string; version: string }>(
      `SELECT DISTINCT m.id AS measure_id, m.name AS measure_name, mv.version AS version
       FROM ${SPIKE_SCHEMA}.measure_value_set_links l
       JOIN ${SPIKE_SCHEMA}.measure_versions mv ON mv.id = l.measure_version_id
       JOIN ${SPIKE_SCHEMA}.measures m ON m.id = mv.measure_id
       WHERE l.value_set_id = ANY($1)
       ORDER BY m.name ASC`,
      [valueSetIds],
    );
    return rows.map((r) => ({ measureId: r.measure_id, measureName: r.measure_name, version: r.version }));
  }

  async listTerminologyMappings(): Promise<TerminologyMappingRecord[]> {
    const { rows } = await this.pool.query<TmRow>(
      `SELECT ${TM_COLS} FROM ${SPIKE_SCHEMA}.terminology_mappings
       ORDER BY mapping_status ASC, local_system ASC, local_code ASC`,
    );
    return rows.map(toTerminology);
  }

  async createTerminologyMapping(input: CreateTerminologyMappingInput): Promise<TerminologyMappingRecord> {
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.terminology_mappings (id, local_code, local_display, local_system,
         standard_code, standard_display, standard_system, mapping_status, mapping_confidence, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.id,
        input.localCode,
        input.localDisplay,
        input.localSystem,
        input.standardCode,
        input.standardDisplay,
        input.standardSystem,
        input.mappingStatus,
        input.mappingConfidence,
        input.notes,
      ],
    );
    const { rows } = await this.pool.query<TmRow>(`SELECT ${TM_COLS} FROM ${SPIKE_SCHEMA}.terminology_mappings WHERE id = $1`, [input.id]);
    return toTerminology(rows[0]!);
  }
}
