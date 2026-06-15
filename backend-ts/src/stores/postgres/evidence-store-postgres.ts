/**
 * Postgres-ceiling implementation of the EvidenceStore contract (#108 evidence).
 * Schema-qualified to the isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { EvidenceRecord, EvidenceStore, InsertEvidenceInput } from "../evidence-store.ts";

interface Row {
  id: string;
  case_id: string;
  uploaded_by: string;
  file_name: string;
  file_size_bytes: string | number;
  mime_type: string;
  storage_key: string;
  description: string | null;
  uploaded_at: Date | string;
}

const toRecord = (r: Row): EvidenceRecord => ({
  id: r.id,
  caseId: r.case_id,
  uploadedBy: r.uploaded_by,
  fileName: r.file_name,
  fileSizeBytes: Number(r.file_size_bytes),
  mimeType: r.mime_type,
  storageKey: r.storage_key,
  description: r.description,
  uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : r.uploaded_at,
});

const SELECT = (schema: string) =>
  `SELECT id, case_id, uploaded_by, file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at FROM ${schema}.evidence_attachments`;

export class PgEvidenceStore implements EvidenceStore {
  constructor(private readonly pool: PgPool) {}

  async insert(input: InsertEvidenceInput): Promise<EvidenceRecord> {
    const uploadedAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.evidence_attachments
         (id, case_id, uploaded_by, file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.caseId,
        input.uploadedBy,
        input.fileName,
        input.fileSizeBytes,
        input.mimeType,
        input.storageKey,
        input.description,
        uploadedAt,
      ],
    );
    return { ...input, uploadedAt };
  }

  async listByCase(caseId: string): Promise<EvidenceRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `${SELECT(SPIKE_SCHEMA)} WHERE case_id = $1 ORDER BY uploaded_at DESC, id DESC`,
      [caseId],
    );
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<EvidenceRecord | null> {
    const { rows } = await this.pool.query<Row>(`${SELECT(SPIKE_SCHEMA)} WHERE id = $1::uuid`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
