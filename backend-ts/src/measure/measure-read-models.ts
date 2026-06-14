/**
 * Measure catalog read models (#107 measures module) — the `Measure` shape the
 * `/measures` page consumes and the list filters, ported from MeasureService.listMeasures.
 *
 * The catalog is static read data for this slice (lifecycle mutations + persisted
 * timestamps land with the measures store). Java orders by COALESCE(activated_at,
 * created_at, updated_at) DESC — i.e. Active (recently activated) first; we mirror that
 * intent with a per-status recency tier so an Active (runnable) measure surfaces first
 * (the runs/studio pickers default to the first row). `lastUpdated`/`statusUpdatedAt` are
 * a deterministic static seed; `statusUpdatedBy` is the owner.
 */
import { MEASURE_CATALOG, type CatalogMeasure, type MeasureStatus } from "./measure-catalog.ts";

export interface Measure {
  id: string;
  name: string;
  policyRef: string;
  version: string;
  status: string;
  owner: string;
  lastUpdated: string;
  tags: string[];
  statusUpdatedAt: string;
  statusUpdatedBy: string;
}

// Static recency tiers (newest first): Active > Approved > Draft > Deprecated. Within a
// tier, name ASC. Fixed dates keep the list deterministic until real timestamps exist.
const TIER: Record<MeasureStatus, string> = {
  Active: "2026-06-10T00:00:00.000Z",
  Approved: "2026-04-01T00:00:00.000Z",
  Draft: "2026-02-01T00:00:00.000Z",
  Deprecated: "2025-06-01T00:00:00.000Z",
};

export function toMeasure(c: CatalogMeasure): Measure {
  const ts = TIER[c.status];
  return {
    id: c.id,
    name: c.name,
    policyRef: c.policyRef,
    version: c.version,
    status: c.status,
    owner: c.owner,
    lastUpdated: ts,
    tags: c.tags,
    statusUpdatedAt: ts,
    statusUpdatedBy: c.owner,
  };
}

const STATUSES = new Set<MeasureStatus>(["Draft", "Approved", "Active", "Deprecated"]);

/**
 * Filter + order the catalog like the Java list endpoint:
 *   - status: exact (case-insensitive) match on the lifecycle status; "All"/blank = no filter
 *   - search: case-insensitive substring on the name OR any tag
 *   - order: lastUpdated DESC (status recency tier), then name ASC
 */
export function listCatalog(opts: { status?: string | null; search?: string | null }): Measure[] {
  const status = opts.status?.trim();
  const normalizedStatus = status && status.toLowerCase() !== "all" ? status.toLowerCase() : null;
  const search = opts.search?.trim().toLowerCase() || null;

  return MEASURE_CATALOG.filter((m) => {
    if (normalizedStatus && m.status.toLowerCase() !== normalizedStatus) return false;
    if (search) {
      const inName = m.name.toLowerCase().includes(search);
      const inTags = m.tags.some((t) => t.toLowerCase().includes(search));
      if (!inName && !inTags) return false;
    }
    return true;
  })
    .map(toMeasure)
    .sort((a, b) => (a.lastUpdated === b.lastUpdated ? a.name.localeCompare(b.name) : b.lastUpdated.localeCompare(a.lastUpdated)));
}

/** Whether a string is a recognized lifecycle status (for validation/UX). */
export const isMeasureStatus = (s: string): s is MeasureStatus => STATUSES.has(s as MeasureStatus);
