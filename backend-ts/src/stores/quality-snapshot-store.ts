/**
 * Storage contract — `QualitySnapshotStore` (#E16). A materialized AGGREGATE of a population run's
 * outcomes per (measure, calendar month, scope) — numerator/denominator + the 5 bucket counts — so
 * "what was measure X's compliance on month M for scope S?" is a bounded table read, never a re-scan
 * of the per-subject `outcomes` (which is O(120k) at population scale). Aggregate-only by design:
 * there is no per-employee row here (that would reintroduce the 160k-row problem; the per-person
 * Simulate path covers it). Descriptive only — CQL `Outcome Status` stays the sole authority
 * (ADR-008); these rows merely COUNT what CQL already decided. Schema/migrations stay Taleef-owned.
 */

/** Scope a snapshot row aggregates over, walking the existing hierarchy. */
export type QualityScopeLevel = "all" | "tenant" | "site" | "provider";

/**
 * A snapshot to persist (no `id` — the adapter assigns/keeps it on upsert). `scopeId` encodes the
 * hierarchy: `"ALL"` | `tenantId` | `` `${tenantId}|${site}` `` | `` `${tenantId}|${site}|${providerId}` ``.
 * `tenantId` is null only for the `"all"` root. `numerator = compliant`; `denominator = total − excluded`
 * (the proportion model, reconciled 1:1 with `countPopulations`).
 */
export interface QualitySnapshotInput {
  measureId: string;
  /** Calendar month `YYYY-MM`. */
  period: string;
  /** ISO-8601 calendar-month bounds (for range display); the actual as-of moment is `computedAt`. */
  periodStart: string;
  periodEnd: string;
  scopeLevel: QualityScopeLevel;
  scopeId: string;
  tenantId: string | null;
  numerator: number;
  denominator: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  /** The run this snapshot was materialized from (null for purely synthetic backfill). */
  sourceRunId: string | null;
  computedAt: string;
}

/** A persisted snapshot row (the write shape + its stable id). */
export interface QualitySnapshotRow extends QualitySnapshotInput {
  id: string;
}

/** Range/scope filter for the history read. `from`/`to` are inclusive `YYYY-MM` bounds. */
export interface QualitySnapshotQuery {
  measureId?: string;
  scopeLevel?: QualityScopeLevel;
  scopeId?: string;
  tenantId?: string;
  from?: string;
  to?: string;
}

export interface QualitySnapshotStore {
  /**
   * Idempotent upsert keyed on (measure_id, period, scope_level, scope_id) — re-materializing the
   * same month/scope (e.g. a second run in the month, or a re-run) overwrites in place (last write
   * wins), never duplicates. A no-op for an empty array.
   */
  upsertSnapshots(inputs: QualitySnapshotInput[]): Promise<void>;
  /** Snapshot rows matching the filter, ordered by period ASC then scopeId — the history time-series. */
  querySnapshots(query: QualitySnapshotQuery): Promise<QualitySnapshotRow[]>;
}
