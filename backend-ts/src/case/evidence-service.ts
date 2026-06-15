/**
 * Evidence service (#108) — TS port of EvidenceService. JVM-free.
 *
 * Upload/list/download of case evidence files. Metadata rows live in the EvidenceStore; the bytes
 * live in the BUCKET binding (R2/fs) under `storageKey`. Content type is detected from the file's
 * MAGIC BYTES (never the client-supplied header), validated against an allow-list, capped at 10MB.
 * Every upload/download writes an audit_event (CLAUDE.md — every state change is audited).
 *
 * Fidelity vs Java: Java used Apache Tika for the text/csv/xlsx tail; we have no Tika, so the strong
 * binary signatures (PNG/JPEG/PDF) are ported exactly, ZIP+`.xlsx` → xlsx, and a UTF-8-decodes check
 * routes the rest to text/csv (`.csv`) or text/plain. A spoofed extension on binary content is still
 * caught by the signature check + allow-list.
 */
import type { CloudBucket } from "@mieweb/cloud";
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { EvidenceRecord, EvidenceStore } from "../stores/evidence-store.ts";

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** 400 — bad request (empty file, unknown case). */
export class EvidenceError extends Error {}
/** 415 — file too large or an unsupported/undetectable content type. */
export class UnsupportedEvidenceTypeError extends Error {}
/** 404 — evidence id not found. */
export class EvidenceNotFoundError extends Error {}
/** 500 — metadata row exists but the stored bytes are gone. */
export class EvidenceMissingError extends Error {}

export interface EvidenceDeps {
  evidence: EvidenceStore;
  cases: CaseStore;
  bucket: CloudBucket;
  events: CaseEventStore;
}

export interface UploadInput {
  bytes: Uint8Array;
  fileName: string | null;
  description: string | null;
}

export interface DownloadedEvidence {
  record: EvidenceRecord;
  bytes: Uint8Array;
  contentType: string;
  /** Images render inline; everything else downloads as an attachment (Java parity). */
  inline: boolean;
}

/** Detect the content type from magic bytes (+ filename hint for xlsx/csv); null if undetectable. */
export function detectMimeType(bytes: Uint8Array, fileName: string | null): string | null {
  // Strong binary signatures: trust content, ignore the filename.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 && // P
    bytes[2] === 0x4e && // N
    bytes[3] === 0x47 && // G
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf"; // %PDF-
  }
  const lowerName = (fileName ?? "").toLowerCase();
  // ZIP container (PK\x03\x04). xlsx is the only allow-listed ZIP type; disambiguate by extension.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return lowerName.endsWith(".xlsx")
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : null; // some other zip (docx/jar/…) — not allow-listed
  }
  // Text tail: only if the bytes decode as valid UTF-8 (rejects arbitrary binary).
  if (isValidUtf8(bytes)) {
    return lowerName.endsWith(".csv") ? "text/csv" : "text/plain";
  }
  return null;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Strip path components + unsafe characters from a client filename (EvidenceService.sanitizeFileName). */
export function sanitizeFileName(fileName: string | null): string {
  let candidate = fileName && fileName.trim() !== "" ? fileName.trim() : "evidence";
  candidate = candidate.replace(/\\/g, "/");
  const lastSlash = candidate.lastIndexOf("/");
  if (lastSlash >= 0) candidate = candidate.slice(lastSlash + 1);
  candidate = candidate.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return candidate === "" ? "evidence" : candidate;
}

export async function uploadEvidence(deps: EvidenceDeps, caseId: string, input: UploadInput, actor: string): Promise<EvidenceRecord> {
  if (!input.bytes || input.bytes.length === 0) throw new EvidenceError("File is required");
  if (input.bytes.length > MAX_EVIDENCE_BYTES) {
    throw new UnsupportedEvidenceTypeError(`File size ${input.bytes.length} exceeds the 10MB limit`);
  }
  const mimeType = detectMimeType(input.bytes, input.fileName);
  if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new UnsupportedEvidenceTypeError(`Unsupported file type${mimeType ? `: ${mimeType}` : ""}`);
  }
  if (!(await deps.cases.getCase(caseId))) throw new EvidenceError("Case not found");

  const safeName = sanitizeFileName(input.fileName);
  const evidenceId = crypto.randomUUID();
  const storageKey = `${caseId}/${evidenceId}-${safeName}`;
  const description = input.description && input.description.trim() !== "" ? input.description.trim() : null;

  await deps.bucket.put(storageKey, input.bytes, { httpMetadata: { contentType: mimeType } });
  const record = await deps.evidence.insert({
    id: evidenceId,
    caseId,
    uploadedBy: actor,
    fileName: safeName,
    fileSizeBytes: input.bytes.length,
    mimeType,
    storageKey,
    description,
  });

  await deps.events.appendAudit({
    eventType: "EVIDENCE_UPLOADED",
    entityType: "evidence",
    entityId: evidenceId,
    actor,
    refRunId: null,
    refCaseId: caseId,
    refMeasureVersionId: null,
    payload: {
      evidenceId,
      fileName: safeName,
      mimeType,
      fileSizeBytes: input.bytes.length,
      description: description ?? "",
      timestamp: record.uploadedAt,
    },
  });
  return record;
}

export async function listEvidence(deps: EvidenceDeps, caseId: string): Promise<EvidenceRecord[]> {
  return deps.evidence.listByCase(caseId);
}

export async function downloadEvidence(deps: EvidenceDeps, evidenceId: string, actor: string): Promise<DownloadedEvidence> {
  const record = await deps.evidence.getById(evidenceId);
  if (!record) throw new EvidenceNotFoundError("Evidence not found");
  if (!(await deps.cases.getCase(record.caseId))) throw new EvidenceError("Case not found");

  const object = await deps.bucket.get(record.storageKey);
  if (!object) throw new EvidenceMissingError("Evidence file is missing");
  const bytes = new Uint8Array(await object.arrayBuffer());

  await deps.events.appendAudit({
    eventType: "EVIDENCE_DOWNLOADED",
    entityType: "evidence",
    entityId: record.id,
    actor,
    refRunId: null,
    refCaseId: record.caseId,
    refMeasureVersionId: null,
    payload: {
      evidenceId: record.id,
      caseId: record.caseId,
      fileName: sanitizeFileName(record.fileName),
      contentType: record.mimeType,
      fileSizeBytes: bytes.length,
      timestamp: new Date().toISOString(),
    },
  });

  return { record, bytes, contentType: record.mimeType, inline: record.mimeType.startsWith("image/") };
}
