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
  /**
   * The upload stamp. Optional and minted by the store when absent, so every existing caller is
   * unchanged — but `uploadEvidence` passes one, because its audit payload carries this exact value as
   * `payload.timestamp` and #598's rule is audit-before-mutate. It was the last of the
   * "the store mints something the event needs" cases that a seam change could reach.
   */
  uploadedAt?: string;
}

export interface EvidenceStore {
  insert(input: InsertEvidenceInput): Promise<EvidenceRecord>;
  /** Attachments for one case, newest-first (uploaded_at DESC). */
  listByCase(caseId: string): Promise<EvidenceRecord[]>;
  getById(id: string): Promise<EvidenceRecord | null>;
}
