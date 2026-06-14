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
import { MEASURE_CATALOG, type CatalogMeasure, type MeasureStatus, type MeasureSpec } from "./measure-catalog.ts";

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

/** Look up a catalog measure by id (the detail/versions routes resolve through this). */
export const findMeasure = (id: string): CatalogMeasure | undefined => MEASURE_CATALOG.find((m) => m.id === id);

// ---- detail + version history (#107 measures module) ------------------------
export interface MeasureDetail {
  id: string;
  name: string;
  policyRef: string;
  oshaReferenceId: string | null;
  version: string;
  status: string;
  owner: string;
  description: string;
  eligibilityCriteria: MeasureSpec["eligibilityCriteria"];
  exclusions: MeasureSpec["exclusions"];
  complianceWindow: string;
  requiredDataElements: string[];
  cqlText: string;
  compileStatus: string;
  valueSets: unknown[];
  testFixtures: unknown[];
}

export interface VersionHistoryItem {
  id: string;
  version: string;
  status: string;
  author: string;
  createdAt: string;
  changeSummary: string;
}

/**
 * Build the Studio `MeasureDetail` from the catalog (spec) + the measure's CQL (reconstructed
 * from ELM by the caller for runnable measures; "" otherwise). osha_references aren't ported,
 * so oshaReferenceId is null; valueSets/testFixtures are [] until the value-set governance
 * surface lands (a separate module). Matches the Java MeasureService.getMeasure field shape.
 */
export function toMeasureDetail(m: CatalogMeasure, cqlText: string): MeasureDetail {
  return {
    id: m.id,
    name: m.name,
    policyRef: m.policyRef,
    oshaReferenceId: null,
    version: m.version,
    status: m.status,
    owner: m.owner,
    description: m.spec.description,
    eligibilityCriteria: m.spec.eligibilityCriteria,
    exclusions: m.spec.exclusions,
    complianceWindow: m.spec.complianceWindow,
    requiredDataElements: m.spec.requiredDataElements,
    cqlText,
    compileStatus: m.compileStatus,
    valueSets: [],
    testFixtures: [],
  };
}

/**
 * Stable static version id for a measure version — distinct from the measure slug, since the
 * Studio uses the version id (not the measure id) to scope `/api/auditor/measure-versions/:id`
 * + MAT-export actions. Until a persisted measures store mints real `measure_versions.id`
 * UUIDs, this `<measureId>-<version>` form keeps those actions version-scoped (not a measure-id
 * masquerade) and forward-compatible.
 */
export const measureVersionId = (m: CatalogMeasure): string => `${m.id}-${m.version}`;

/** Version history for a measure — the static catalog carries one version per measure. */
export function toVersionHistory(m: CatalogMeasure): VersionHistoryItem[] {
  return [
    {
      id: measureVersionId(m),
      version: m.version,
      status: m.status,
      author: m.owner,
      createdAt: TIER[m.status],
      changeSummary: "Seeded measure version",
    },
  ];
}
