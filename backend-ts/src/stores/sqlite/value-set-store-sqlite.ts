/**
 * SQLite/D1 floor implementation of the ValueSetStore contract (#108 value-set governance).
 * codes_json / code_systems are JSON TEXT on the floor. measure_version_id is the floor
 * version id (<measureId>-<version> TEXT).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type {
  CodeEntry,
  CreateTerminologyMappingInput,
  SeedValueSetInput,
  TerminologyMappingRecord,
  UpsertResolvedValueSetInput,
  ValueSetRecord,
  ValueSetStore,
} from "../value-set-store.ts";

interface VsRow {
  id: string;
  oid: string;
  name: string;
  version: string | null;
  codes_json: string;
  last_resolved_at: string | null;
  canonical_url: string | null;
  code_systems: string;
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
  mapping_confidence: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
}

function parseCodes(json: string | null): CodeEntry[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as Array<Record<string, unknown>>;
    if (!Array.isArray(raw)) return [];
    return raw.map((c) => ({
      code: String(c.code ?? ""),
      display: String(c.display ?? ""),
      system: String(c.system ?? ""),
    }));
  } catch {
    return [];
  }
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    return Array.isArray(raw) ? raw.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

const toRecord = (r: VsRow): ValueSetRecord => ({
  id: r.id,
  oid: r.oid,
  name: r.name,
  version: r.version,
  lastResolvedAt: r.last_resolved_at,
  canonicalUrl: r.canonical_url ?? "",
  source: r.source ?? "",
  governanceStatus: r.status,
  resolutionStatus: r.resolution_status,
  resolutionError: r.resolution_error ?? "",
  expansionHash: r.expansion_hash ?? "",
  codeSystems: parseStringArray(r.code_systems),
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
  reviewedAt: r.reviewed_at,
  notes: r.notes,
});

const VS_SELECT =
  "SELECT id, oid, name, version, codes_json, last_resolved_at, canonical_url, code_systems, source, status, expansion_hash, resolution_status, resolution_error FROM value_sets";

const TM_SELECT =
  "SELECT id, local_code, local_display, local_system, standard_code, standard_display, standard_system, mapping_status, mapping_confidence, reviewed_by, reviewed_at, notes FROM terminology_mappings";

export class SqliteValueSetStore implements ValueSetStore {
  constructor(private readonly db: CloudDatabase) {}

  async isEmpty(): Promise<boolean> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM value_sets").first<{ n: number }>();
    return Number(row?.n ?? 0) === 0;
  }

  async seedValueSet(input: SeedValueSetInput): Promise<void> {
    const codesJson = JSON.stringify(input.codes);
    const systems = JSON.stringify([...new Set(input.codes.map((c) => c.system).filter(Boolean))]);
    const now = new Date().toISOString();
    // Drop a colliding (oid,version) row under a different id, then upsert by id (mirrors ensureValueSet).
    await this.db.prepare("DELETE FROM value_sets WHERE oid = ? AND id <> ?").bind(input.oid, input.id).run();
    await this.db
      .prepare(
        `INSERT INTO value_sets (id, oid, name, version, codes_json, code_systems, source, status, resolution_status, last_resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'WorkWell Demo', 'ACTIVE', 'RESOLVED', ?)
         ON CONFLICT(id) DO UPDATE SET
           oid = excluded.oid, name = excluded.name, version = excluded.version,
           codes_json = excluded.codes_json, code_systems = excluded.code_systems,
           resolution_status = 'RESOLVED', last_resolved_at = excluded.last_resolved_at`,
      )
      .bind(input.id, input.oid, input.name, input.version, codesJson, systems, now)
      .run();
  }

  async setCodes(id: string, codes: { code: string; display: string; system: string }[]): Promise<void> {
    const codesJson = JSON.stringify(codes);
    const systems = JSON.stringify([...new Set(codes.map((c) => c.system).filter(Boolean))]);
    // Codes-only update — never touches status/version/resolution_status/last_resolved_at (preserves
    // operator-managed governance metadata, unlike seedValueSet's upsert).
    await this.db
      .prepare("UPDATE value_sets SET codes_json = ?, code_systems = ? WHERE id = ?")
      .bind(codesJson, systems, id)
      .run();
  }

  async upsertResolvedValueSet(input: UpsertResolvedValueSetInput): Promise<void> {
    const codesJson = JSON.stringify(input.codes);
    const systems = JSON.stringify([...new Set(input.codes.map((c) => c.system).filter(Boolean))].sort());
    // Idempotent by OID: reuse the existing row's id (stable across re-resolves) and drop any other
    // rows sharing this OID, then upsert on id — the same OID-dedup mechanism seedValueSet uses
    // (DELETE-by-oid + ON CONFLICT(id)). Keying by OID means a null version still dedupes (the
    // UNIQUE(oid,version) index would treat NULLs as distinct, so we never rely on it here).
    const existing = await this.db.prepare("SELECT id FROM value_sets WHERE oid = ?").bind(input.oid).first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();
    await this.db.prepare("DELETE FROM value_sets WHERE oid = ? AND id <> ?").bind(input.oid, id).run();
    await this.db
      .prepare(
        `INSERT INTO value_sets
           (id, oid, name, version, codes_json, code_systems, source, status,
            resolution_status, resolution_error, expansion_hash, last_resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           oid = excluded.oid, name = excluded.name, version = excluded.version,
           codes_json = excluded.codes_json, code_systems = excluded.code_systems,
           source = excluded.source, status = 'ACTIVE', resolution_status = excluded.resolution_status,
           resolution_error = excluded.resolution_error, expansion_hash = excluded.expansion_hash,
           last_resolved_at = excluded.last_resolved_at`,
      )
      .bind(
        id,
        input.oid,
        input.name,
        input.version,
        codesJson,
        systems,
        input.source,
        input.resolutionStatus,
        input.resolutionError,
        input.expansionHash,
        input.lastResolvedAt,
      )
      .run();
  }

  async link(measureVersionId: string, valueSetId: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO measure_value_set_links (measure_version_id, value_set_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      )
      .bind(measureVersionId, valueSetId)
      .run();
  }

  async unlink(measureVersionId: string, valueSetId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM measure_value_set_links WHERE measure_version_id = ? AND value_set_id = ?")
      .bind(measureVersionId, valueSetId)
      .run();
  }

  async listAll(): Promise<ValueSetRecord[]> {
    const { results } = await this.db.prepare(`${VS_SELECT} ORDER BY name ASC, oid ASC`).all<VsRow>();
    return (results ?? []).map(toRecord);
  }

  async getById(id: string): Promise<ValueSetRecord | null> {
    const row = await this.db.prepare(`${VS_SELECT} WHERE id = ?`).bind(id).first<VsRow>();
    return row ? toRecord(row) : null;
  }

  async create(oid: string, name: string, version: string | null): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO value_sets (id, oid, name, version, codes_json, code_systems, status, resolution_status, last_resolved_at)
         VALUES (?, ?, ?, ?, '[]', '[]', 'DRAFT', 'UNKNOWN', ?)`,
      )
      .bind(id, oid, name, version && version.trim() !== "" ? version : "unspecified", now)
      .run();
    return id;
  }

  async listByVersion(measureVersionId: string): Promise<ValueSetRecord[]> {
    const joined = await this.db
      .prepare(
        `SELECT vs.id, vs.oid, vs.name, vs.version, vs.codes_json, vs.last_resolved_at, vs.canonical_url,
                vs.code_systems, vs.source, vs.status, vs.expansion_hash, vs.resolution_status, vs.resolution_error
         FROM measure_value_set_links l
         JOIN value_sets vs ON vs.id = l.value_set_id
         WHERE l.measure_version_id = ?
         ORDER BY vs.name ASC, vs.oid ASC`,
      )
      .bind(measureVersionId)
      .all<VsRow>();
    return (joined.results ?? []).map(toRecord);
  }

  async affectedMeasures(valueSetIds: string[]): Promise<Array<{ measureId: string; measureName: string; version: string }>> {
    if (valueSetIds.length === 0) return [];
    const placeholders = valueSetIds.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT m.id AS measure_id, m.name AS measure_name, mv.version AS version
         FROM measure_value_set_links l
         JOIN measure_versions mv ON mv.id = l.measure_version_id
         JOIN measures m ON m.id = mv.measure_id
         WHERE l.value_set_id IN (${placeholders})
         ORDER BY m.name ASC`,
      )
      .bind(...valueSetIds)
      .all<{ measure_id: string; measure_name: string; version: string }>();
    return (results ?? []).map((r) => ({ measureId: r.measure_id, measureName: r.measure_name, version: r.version }));
  }

  async listTerminologyMappings(): Promise<TerminologyMappingRecord[]> {
    const { results } = await this.db
      .prepare(`${TM_SELECT} ORDER BY mapping_status ASC, local_system ASC, local_code ASC`)
      .all<TmRow>();
    return (results ?? []).map(toTerminology);
  }

  async createTerminologyMapping(input: CreateTerminologyMappingInput): Promise<TerminologyMappingRecord> {
    await this.db
      .prepare(
        `INSERT INTO terminology_mappings (id, local_code, local_display, local_system,
           standard_code, standard_display, standard_system, mapping_status, mapping_confidence, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      )
      .run();
    const row = await this.db.prepare(`${TM_SELECT} WHERE id = ?`).bind(input.id).first<TmRow>();
    return toTerminology(row!);
  }
}
