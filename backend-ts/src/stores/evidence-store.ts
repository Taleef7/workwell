/**
 * EvidenceStore contract (#108 evidence) — file METADATA for case evidence attachments.
 * The file BYTES live in the BUCKET binding (R2/fs) under `storageKey`; this store holds only
 * the row that points at them. Mirrors the canonical evidence_attachments table (DATA_MODEL / V006).
 */
export interface EvidenceRecord {
  id: string;
  caseId: string;
  uploadedBy: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  storageKey: string;
  description: string | null;
  uploadedAt: string;
}

export interface InsertEvidenceInput {
  id: string;
  caseId: string;
  uploadedBy: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  storageKey: string;
  description: string | null;
}

export interface EvidenceStore {
  insert(input: InsertEvidenceInput): Promise<EvidenceRecord>;
  /** Attachments for one case, newest-first (uploaded_at DESC). */
  listByCase(caseId: string): Promise<EvidenceRecord[]>;
  getById(id: string): Promise<EvidenceRecord | null>;
}
