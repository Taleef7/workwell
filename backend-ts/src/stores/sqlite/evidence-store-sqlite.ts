/**
 * SQLite/D1 floor implementation of the EvidenceStore contract (#108 evidence).
 * Metadata only; the file bytes live in the BUCKET binding under storage_key.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { EvidenceRecord, EvidenceStore, InsertEvidenceInput } from "../evidence-store.ts";

interface Row {
  id: string;
  case_id: string;
  uploaded_by: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  storage_key: string;
  description: string | null;
  uploaded_at: string;
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
  uploadedAt: r.uploaded_at,
});

const SELECT =
  "SELECT id, case_id, uploaded_by, file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at FROM evidence_attachments";

export class SqliteEvidenceStore implements EvidenceStore {
  constructor(private readonly db: CloudDatabase) {}

  async insert(input: InsertEvidenceInput): Promise<EvidenceRecord> {
    const uploadedAt = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO evidence_attachments
           (id, case_id, uploaded_by, file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.caseId,
        input.uploadedBy,
        input.fileName,
        input.fileSizeBytes,
        input.mimeType,
        input.storageKey,
        input.description,
        uploadedAt,
      )
      .run();
    return { ...input, uploadedAt };
  }

  async listByCase(caseId: string): Promise<EvidenceRecord[]> {
    const { results } = await this.db
      .prepare(`${SELECT} WHERE case_id = ? ORDER BY uploaded_at DESC, id DESC`)
      .bind(caseId)
      .all<Row>();
    return (results ?? []).map(toRecord);
  }

  async getById(id: string): Promise<EvidenceRecord | null> {
    const row = await this.db.prepare(`${SELECT} WHERE id = ?`).bind(id).first<Row>();
    return row ? toRecord(row) : null;
  }
}
