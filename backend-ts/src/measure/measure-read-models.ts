/**
 * Measure read models (#107 measures module) — the frontend shapes (`Measure`,
 * `MeasureDetail`, `VersionHistoryItem`, `ActivationReadiness`) built from the persisted
 * MeasureStore records. Ported from MeasureService.listMeasures / getMeasure /
 * listVersionHistory / activationReadiness.
 */
import type { MeasureRecord } from "../stores/measure-store.ts";
import type { MeasureSpec, MeasureStatus } from "./measure-catalog.ts";

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

/** Java's COALESCE(activated_at, created_at, updated_at) — the version's effective recency. */
const lastUpdatedOf = (r: MeasureRecord): string => r.activatedAt ?? r.createdAt ?? r.updatedAt;

export function toMeasure(r: MeasureRecord): Measure {
  const ts = lastUpdatedOf(r);
  return {
    id: r.measureId,
    name: r.name,
    policyRef: r.policyRef,
    version: r.version,
    status: r.status,
    owner: r.owner,
    lastUpdated: ts,
    tags: r.tags,
    statusUpdatedAt: ts,
    statusUpdatedBy: r.approvedBy ?? r.owner ?? "system",
  };
}

const STATUSES = new Set<MeasureStatus>(["Draft", "Approved", "Active", "Deprecated"]);
export const isMeasureStatus = (s: string): s is MeasureStatus => STATUSES.has(s as MeasureStatus);

/**
 * Filter + order latest-version records like the Java list endpoint:
 *   - status: exact (case-insensitive) match; "All"/blank = no filter
 *   - search: case-insensitive substring on name OR any tag
 *   - order: lastUpdated DESC, then name ASC
 */
export function listMeasures(records: MeasureRecord[], opts: { status?: string | null; search?: string | null }): Measure[] {
  const status = opts.status?.trim();
  const normalizedStatus = status && status.toLowerCase() !== "all" ? status.toLowerCase() : null;
  const search = opts.search?.trim().toLowerCase() || null;
  return records
    .filter((r) => {
      if (normalizedStatus && r.status.toLowerCase() !== normalizedStatus) return false;
      if (search) {
        const inName = r.name.toLowerCase().includes(search);
        const inTags = r.tags.some((t) => t.toLowerCase().includes(search));
        if (!inName && !inTags) return false;
      }
      return true;
    })
    .map(toMeasure)
    .sort((a, b) => (a.lastUpdated === b.lastUpdated ? a.name.localeCompare(b.name) : b.lastUpdated.localeCompare(a.lastUpdated)));
}

// ---- detail + version history ------------------------------------------------
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
 * The Studio MeasureDetail. osha_references aren't ported (oshaReferenceId = null);
 * valueSets/testFixtures are [] until the value-set governance surface lands.
 */
export function toMeasureDetail(r: MeasureRecord): MeasureDetail {
  return {
    id: r.measureId,
    name: r.name,
    policyRef: r.policyRef,
    oshaReferenceId: null,
    version: r.version,
    status: r.status,
    owner: r.owner,
    description: r.spec.description,
    eligibilityCriteria: r.spec.eligibilityCriteria,
    exclusions: r.spec.exclusions,
    complianceWindow: r.spec.complianceWindow,
    requiredDataElements: r.spec.requiredDataElements,
    cqlText: r.cqlText,
    compileStatus: r.compileStatus,
    valueSets: [],
    testFixtures: [],
  };
}

export function toVersionHistory(records: MeasureRecord[]): VersionHistoryItem[] {
  return records.map((r) => ({
    id: r.versionId,
    version: r.version,
    status: r.status,
    author: r.approvedBy ?? r.owner ?? "system",
    createdAt: r.createdAt,
    changeSummary: r.changeSummary ?? "",
  }));
}

// ---- activation readiness ----------------------------------------------------
export interface ActivationReadiness {
  ready: boolean;
  compileStatus: string;
  testFixtureCount: number;
  valueSetCount: number;
  testValidationPassed: boolean;
  activationBlockers: string[];
}

/** Compile gate: activation allowed only from COMPILED or WARNINGS (Java allowsActivationCompileStatus). */
export const compileAllowsActivation = (s: string) => s.toUpperCase() === "COMPILED" || s.toUpperCase() === "WARNINGS";

/**
 * Whether a measure can be activated (MeasureService.activationReadiness). No test fixtures or
 * attached value sets are ported yet, so validateTests fails with the "at least one fixture
 * required" blocker → `ready` is false for every measure (faithful: the Java seed has no
 * fixtures either). NOT_COMPILED measures additionally carry the compile blocker.
 */
export function toActivationReadiness(r: MeasureRecord): ActivationReadiness {
  const compilePassed = compileAllowsActivation(r.compileStatus);
  const blockers: string[] = [];
  if (!compilePassed) blockers.push("Compile status must be COMPILED or WARNINGS.");
  blockers.push("At least one test fixture is required before activation.");
  return {
    ready: false, // compilePassed && testValidationPassed; testValidation fails with no fixtures
    compileStatus: r.compileStatus,
    testFixtureCount: 0,
    valueSetCount: 0,
    testValidationPassed: false,
    activationBlockers: blockers,
  };
}
