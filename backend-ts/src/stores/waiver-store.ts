/**
 * WaiverStore contract (#108 admin write CRUD — waivers). The persisted medical-waiver records
 * behind Admin → Waivers. Mirrors the canonical `waivers` table (V009), but — like the other TS
 * floor tables — the FK columns are plain TEXT: `employee_external_id` (the synthetic directory has
 * no employees table), `measure_id` (the measure slug), `measure_version_id` (the floor version id).
 * Employee name/site + measure name/version are resolved at read time (see admin/waivers.ts), so the
 * store returns only the raw row; the service joins in the display fields, matching Java's read JOIN.
 */
export interface WaiverRow {
  id: string;
  employeeExternalId: string;
  measureId: string;
  measureVersionId: string;
  exclusionReason: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  notes: string | null;
  active: boolean;
}

export interface InsertWaiverInput {
  id: string;
  employeeExternalId: string;
  measureId: string;
  measureVersionId: string;
  exclusionReason: string;
  grantedBy: string;
  expiresAt: string | null;
  notes: string | null;
  active: boolean;
}

/** SQL-level filters (employee `site` is resolved/filtered in the service, not stored here). */
export interface WaiverQuery {
  measureId?: string | null;
  active?: boolean | null;
  expiresAfter?: string | null;
  expiresBefore?: string | null;
}

export interface WaiverStore {
  /** Insert a waiver; returns the stored raw row. */
  insert(input: InsertWaiverInput): Promise<WaiverRow>;
  /** Raw rows ordered active DESC, expires_at ASC NULLS LAST, granted_at DESC (Java order). */
  list(query: WaiverQuery): Promise<WaiverRow[]>;
  getById(id: string): Promise<WaiverRow | null>;
}
