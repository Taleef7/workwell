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
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

export type DeploymentProfileId = "default" | "maui";
type VisibleTenantSelection = "all" | readonly ["maui"];

export interface DeploymentProfile {
  readonly id: DeploymentProfileId;
  readonly visibleTenantIds: VisibleTenantSelection;
  readonly runnableMeasureIds: readonly string[];
}

export interface DeploymentDirectory extends SyntheticDirectoryView {
  readonly EVALUABLE_EMPLOYEES: readonly EmployeeProfile[];
  readonly EVALUATION_EXCLUDED_TENANTS: ReadonlySet<string>;
}

const MAUI_MEASURE_IDS = ["cms122", "cms125", "hypertension"] as const;
const DEFAULT_MEASURE_IDS = Object.keys(MEASURES);

/** Pure profile resolution. Input normalization is deliberately separate from warning side effects. */
export function resolveDeploymentProfile(name: string | undefined): DeploymentProfile {
  const normalized = (name ?? "").trim().toLowerCase();
  if (normalized === "maui") {
    return { id: "maui", visibleTenantIds: ["maui"], runnableMeasureIds: MAUI_MEASURE_IDS };
  }
  return { id: "default", visibleTenantIds: "all", runnableMeasureIds: DEFAULT_MEASURE_IDS };
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
const DEPLOYMENT_DIRECTORY = composeDeploymentDirectory(DEPLOYMENT_PROFILE);

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
const RUNNABLE_MEASURE_ID_SET = new Set(RUNNABLE_MEASURE_IDS);

/** True only when the loaded deployment profile permits this registry measure to run. */
export const isRunnableMeasure = (measureId: string): boolean => RUNNABLE_MEASURE_ID_SET.has(measureId);

/** The configured live WebChart tenant is visible only on the default profile. */
export const webChartTenant = (env: DataSourceEnv): Tenant | null =>
  DEPLOYMENT_PROFILE.id === "default" ? rawWebChartTenant(env) : null;

export type { DataSourceEnv, EmployeeProfile, Enterprise, Provider, Tenant };
