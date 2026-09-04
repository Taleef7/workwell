import {
  scopedSyntheticDirectory,
  TENANTS as ALL_TENANTS,
  webChartTenant as rawWebChartTenant,
  type EmployeeProfile,
  type Enterprise,
  type Provider,
  type SyntheticDirectoryView,
  type Tenant,
} from "../engine/synthetic/employee-catalog.ts";
import type { DirectorySnapshot } from "../engine/ingress/webchart/live-directory.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { officialMeasureIds } from "../wiring/official-routing.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { isVendoredOfficialMeasure } from "./official-measure-ids.ts";

export type DeploymentProfileId = "default" | "maui";
export type SubjectTerm = "employee" | "patient";
type VisibleTenantSelection = "all" | readonly ["maui"];

export interface DeploymentProfile {
  readonly id: DeploymentProfileId;
  readonly subjectTerm: SubjectTerm;
  readonly visibleTenantIds: VisibleTenantSelection;
  readonly runnableMeasureIds: readonly string[];
}

export function subjectNoun(profile: Pick<DeploymentProfile, "subjectTerm">): {
  singular: SubjectTerm;
  plural: "employees" | "patients";
} {
  return profile.subjectTerm === "employee"
    ? { singular: "employee", plural: "employees" }
    : { singular: "patient", plural: "patients" };
}

export interface DeploymentDirectory extends SyntheticDirectoryView {
  readonly EVALUABLE_EMPLOYEES: readonly EmployeeProfile[];
  readonly EVALUATION_EXCLUDED_TENANTS: ReadonlySet<string>;
}

export type RunnableKind =
  | { kind: "authored" }
  | { kind: "official" }
  | { kind: "official-pending"; reason: string }
  | { kind: "invalid"; reason: string };

/**
 * ADR-072 part 1. A measure id is runnable iff the profile lists it AND either
 *  (a) authored: registry + synthetic binding both exist; or
 *  (b) official-only: vendored + semantics recorded + named in WORKWELL_OFFICIAL_MEASURES.
 * An id that is both authored and routed is "official" (routing wins, as the router already decides).
 * Pure: `env` is passed in, never read from process.env here, so the routing flag is read at CALL time.
 */
export function classifyRunnable(id: string, env: Record<string, unknown>): RunnableKind {
  const routed = officialMeasureIds(env).has(id);
  const authored = Boolean(MEASURES[id] && MEASURE_BINDINGS[id]);
  if (routed && isVendoredOfficialMeasure(id) && officialMeasureSemantics(id)) return { kind: "official" };
  if (authored) return { kind: "authored" };
  if (!isVendoredOfficialMeasure(id)) return { kind: "invalid", reason: `${id}: not authored and not vendored under measures/official/` };
  if (!officialMeasureSemantics(id)) return { kind: "invalid", reason: `${id}: vendored but has no OFFICIAL_MEASURE_SEMANTICS entry` };
  return { kind: "official-pending", reason: `${id}: official-only and not named in WORKWELL_OFFICIAL_MEASURES on this deployment` };
}

/** Module-load validation checks only the env-independent half: every listed id must be authored OR (vendored + semantics). */
export function validateRunnableMeasureIds(ids: readonly string[]): readonly string[] {
  const invalid = ids.map((id) => classifyRunnable(id, {})).filter((k): k is { kind: "invalid"; reason: string } => k.kind === "invalid");
  if (invalid.length > 0) throw new Error(`[workwell] Invalid runnable measure id(s): ${invalid.map((k) => k.reason).join("; ")}`);
  return ids;
}

const MAUI_MEASURE_IDS = ["cms122", "cms125", "cms2", "cms130", "cms165"] as const;
const DEFAULT_MEASURE_IDS = Object.keys(MEASURES);
validateRunnableMeasureIds(MAUI_MEASURE_IDS);
validateRunnableMeasureIds(DEFAULT_MEASURE_IDS);

/** Pure profile resolution. Input normalization is deliberately separate from warning side effects. */
export function resolveDeploymentProfile(name: string | undefined): DeploymentProfile {
  const normalized = (name ?? "").trim().toLowerCase();
  if (normalized === "maui") {
    return { id: "maui", subjectTerm: "patient", visibleTenantIds: ["maui"], runnableMeasureIds: MAUI_MEASURE_IDS };
  }
  return { id: "default", subjectTerm: "employee", visibleTenantIds: "all", runnableMeasureIds: DEFAULT_MEASURE_IDS };
}

/** Pure composition over the fully attributed synthetic directory. */
export function composeDeploymentDirectory(profile: DeploymentProfile): DeploymentDirectory {
  const tenantIds = profile.visibleTenantIds === "all"
    ? new Set(ALL_TENANTS.map((tenant) => tenant.id))
    : new Set(profile.visibleTenantIds);
  if (profile.id === "default") tenantIds.add("wc");
  const directory = scopedSyntheticDirectory(tenantIds);
  const excluded = new Set(
    ALL_TENANTS
      .filter((tenant) => profile.id === "maui" ? !tenantIds.has(tenant.id) : tenant.id === "maui")
      .map((tenant) => tenant.id),
  );

  return {
    ...directory,
    EVALUATION_EXCLUDED_TENANTS: excluded,
    EVALUABLE_EMPLOYEES: directory.EMPLOYEES.filter((employee) => !excluded.has(employee.tenantId)),
  };
}

const requestedInstance = process.env.WORKWELL_INSTANCE;
const normalizedInstance = (requestedInstance ?? "").trim().toLowerCase();
if (normalizedInstance && normalizedInstance !== "default" && normalizedInstance !== "twh" && normalizedInstance !== "maui") {
  console.warn(
    `[workwell] Unrecognized WORKWELL_INSTANCE ${JSON.stringify(requestedInstance)}; using the default deployment profile.`,
  );
}

export const DEPLOYMENT_PROFILE = resolveDeploymentProfile(requestedInstance);
console.warn(
  `[workwell] WORKWELL_INSTANCE=${JSON.stringify(requestedInstance ?? "")} resolved deployment profile=${DEPLOYMENT_PROFILE.id}`,
);
const DEPLOYMENT_DIRECTORY = composeDeploymentDirectory(DEPLOYMENT_PROFILE);

/** Lower-case directory snapshot for app-side consumers of the engine's live-directory seam. */
export const DIRECTORY: DirectorySnapshot = {
  employees: DEPLOYMENT_DIRECTORY.EMPLOYEES,
  employeeById: DEPLOYMENT_DIRECTORY.employeeById,
  providerById: DEPLOYMENT_DIRECTORY.providerById,
  tenantById: DEPLOYMENT_DIRECTORY.tenantById,
  enterpriseForTenant: DEPLOYMENT_DIRECTORY.enterpriseForTenant,
};

export const EMPLOYEES = DEPLOYMENT_DIRECTORY.EMPLOYEES;
export const PROVIDERS = DEPLOYMENT_DIRECTORY.PROVIDERS;
export const TENANTS = DEPLOYMENT_DIRECTORY.TENANTS;
export const EVALUABLE_EMPLOYEES = DEPLOYMENT_DIRECTORY.EVALUABLE_EMPLOYEES;
export const EVALUATION_EXCLUDED_TENANTS = DEPLOYMENT_DIRECTORY.EVALUATION_EXCLUDED_TENANTS;
export const employeeById = DEPLOYMENT_DIRECTORY.employeeById;
export const providerById = DEPLOYMENT_DIRECTORY.providerById;
export const tenantById = DEPLOYMENT_DIRECTORY.tenantById;
export const enterpriseForTenant = DEPLOYMENT_DIRECTORY.enterpriseForTenant;
export const employeesForTenant = DEPLOYMENT_DIRECTORY.employeesForTenant;
export const providersForLocation = DEPLOYMENT_DIRECTORY.providersForLocation;
export const RUNNABLE_MEASURE_IDS = DEPLOYMENT_PROFILE.runnableMeasureIds;

/** Lazy + memoized per (id): the routing env is read at first call, matching official-routing.ts. */
const runnableMemo = new Map<string, boolean>();
export const isRunnableMeasure = (measureId: string): boolean => {
  const memo = runnableMemo.get(measureId);
  if (memo !== undefined) return memo;
  const listed = (RUNNABLE_MEASURE_IDS as readonly string[]).includes(measureId);
  const kind = classifyRunnable(measureId, process.env as Record<string, unknown>).kind;
  const runnable = listed && (kind === "authored" || kind === "official");
  runnableMemo.set(measureId, runnable);
  return runnable;
};
/** Test seam only — clears the memo so a test can change WORKWELL_OFFICIAL_MEASURES in-process. */
export const __resetRunnableMemo = (): void => runnableMemo.clear();

/** True for every subject on the default profile; scoped profiles require a directory match. */
export const profileSubjectMatcher = (employeeLookup: (externalId: string) => EmployeeProfile | null) =>
  DEPLOYMENT_PROFILE.id === "default"
    ? (_subjectId: string) => true
    : (subjectId: string) => employeeLookup(subjectId) !== null;

/** The configured live WebChart tenant is visible only on the default profile. */
export const webChartTenant = (env: DataSourceEnv): Tenant | null =>
  DEPLOYMENT_PROFILE.id === "default" ? rawWebChartTenant(env) : null;

export type { DataSourceEnv, EmployeeProfile, Enterprise, Provider, Tenant };
