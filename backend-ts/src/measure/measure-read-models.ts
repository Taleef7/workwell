/**
 * Measure read models (#107 measures module) — the frontend shapes (`Measure`,
 * `MeasureDetail`, `VersionHistoryItem`, `ActivationReadiness`) built from the persisted
 * MeasureStore records. Ported from MeasureService.listMeasures / getMeasure /
 * listVersionHistory / activationReadiness.
 */
import type { MeasureRecord } from "../stores/measure-store.ts";
import type { MeasureSpec, MeasureStatus } from "./measure-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

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
  rule?: MeasureSpec["rule"];
  ruleBindings?: MeasureSpec["ruleBindings"];
  jurisdiction: string;
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
 * The Studio MeasureDetail. osha_references aren't ported (oshaReferenceId = null). `valueSets`
 * is the measure version's attached value sets (value-set governance, #108) — supplied by the
 * route from the ValueSetStore; defaults to [] for callers that don't resolve them.
 */
export function toMeasureDetail(r: MeasureRecord, valueSets: unknown[] = []): MeasureDetail {
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
    valueSets,
    testFixtures: r.spec.testFixtures ?? [],
    rule: r.spec.rule,
    ruleBindings: r.spec.ruleBindings,
    jurisdiction: MEASURES[r.measureId]?.jurisdiction ?? "US",
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

const OUTCOME_BUCKETS = new Set(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"]);

/** Port of MeasureService.validateTests: a fixture set passes when non-empty and each fixture is well-formed. */
export function validateTests(fixtures: MeasureSpec["testFixtures"]): { passed: boolean; failures: string[] } {
  if (fixtures.length === 0) return { passed: false, failures: ["At least one test fixture is required before activation."] };
  const failures: string[] = [];
  fixtures.forEach((f, i) => {
    if (!f.fixtureName?.trim()) failures.push(`Fixture ${i + 1} must include fixtureName.`);
    if (!f.employeeExternalId?.trim()) failures.push(`Fixture ${i + 1} must include employeeExternalId.`);
    if (!OUTCOME_BUCKETS.has(f.expectedOutcome)) failures.push(`Fixture ${i + 1} has unsupported expectedOutcome: ${f.expectedOutcome}`);
  });
  return { passed: failures.length === 0, failures };
}

/**
 * Whether a measure can be activated (MeasureService.activationReadiness). The seeded OSHA
 * measures carry demo test fixtures (V015) → they validate and report `ready` true; measures
 * without fixtures (HEDIS/CMS runnable + catalog drafts) report the fixture blocker — matching
 * the Java contract. valueSetCount stays 0 until the value-set governance surface lands (a
 * separate module); it is informational and does not gate activation.
 */
export function toActivationReadiness(r: MeasureRecord): ActivationReadiness {
  const fixtures = r.spec.testFixtures ?? [];
  const compilePassed = compileAllowsActivation(r.compileStatus);
  const tv = validateTests(fixtures);
  const blockers: string[] = [];
  if (!compilePassed) blockers.push("Compile status must be COMPILED or WARNINGS.");
  if (!tv.passed) blockers.push(...tv.failures);
  return {
    ready: compilePassed && tv.passed,
    compileStatus: r.compileStatus,
    testFixtureCount: fixtures.length,
    valueSetCount: 0,
    testValidationPassed: tv.passed,
    activationBlockers: blockers,
  };
}

/**
 * Fold a value-set resolve-check into the base readiness (MeasureController.activationReadiness):
 * ready becomes base.ready && allResolved, the value-set blockers append, and valueSetCount is
 * the count of attached value sets.
 */
export function withValueSetResolution(
  base: ActivationReadiness,
  vs: { allResolved: boolean; blockers: string[]; valueSetCount: number },
): ActivationReadiness {
  return {
    ...base,
    ready: base.ready && vs.allResolved,
    valueSetCount: vs.valueSetCount,
    activationBlockers: [...base.activationBlockers, ...vs.blockers],
  };
}
