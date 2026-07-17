import {
  EMPLOYEES,
  employeeById as staticEmployeeById,
  enterpriseForTenant as staticEnterpriseForTenant,
  providerById as staticProviderById,
  tenantById as staticTenantById,
  type EmployeeProfile,
  type Enterprise,
  type Provider,
  type Tenant,
} from "../../synthetic/employee-catalog.ts";

const WEBCHART_PROVIDER: Provider = {
  id: "wc-provider-1",
  name: "WebChart Clinician",
  location: "WebChart",
  tenantId: "wc",
};
const WEBCHART_TENANT: Tenant = { id: "wc", name: "WebChart" };
const WEBCHART_ENTERPRISE: Enterprise = { id: "wc", name: "WebChart", tenantId: "wc" };

export interface DirectorySnapshot {
  readonly employees: readonly EmployeeProfile[];
  readonly employeeById: (externalId: string) => EmployeeProfile | null;
  readonly providerById: (id: string) => Provider | null;
  readonly tenantById: (id: string) => Tenant | null;
  readonly enterpriseForTenant: (tenantId: string) => Enterprise | null;
}

let liveEmployees: readonly EmployeeProfile[] = [];

const STATIC_DIRECTORY: DirectorySnapshot = {
  employees: EMPLOYEES,
  employeeById: staticEmployeeById,
  providerById: staticProviderById,
  tenantById: staticTenantById,
  enterpriseForTenant: staticEnterpriseForTenant,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstPatient(bundle: unknown): Record<string, unknown> | null {
  if (!isObject(bundle) || bundle.resourceType !== "Bundle" || !Array.isArray(bundle.entry)) return null;
  for (const item of bundle.entry) {
    const resource = isObject(item) ? item.resource : undefined;
    if (isObject(resource) && resource.resourceType === "Patient" && typeof resource.id === "string" && resource.id) {
      return resource;
    }
  }
  return null;
}

function rawPatientId(externalId: string): string {
  return externalId.slice("wc|".length);
}

function minimalProfile(externalId: string): EmployeeProfile {
  return {
    externalId,
    name: rawPatientId(externalId),
    role: "employee",
    tenantId: "wc",
    site: "WebChart",
    providerId: "wc-provider-1",
  };
}

function profileFromPatient(patient: Record<string, unknown>): EmployeeProfile {
  const id = patient.id as string;
  const firstName = Array.isArray(patient.name) && isObject(patient.name[0]) ? patient.name[0] : undefined;
  const given = firstName && Array.isArray(firstName.given)
    ? firstName.given.filter((part): part is string => typeof part === "string" && part.length > 0)
    : [];
  const family = firstName && typeof firstName.family === "string" ? firstName.family : "";
  const structuredName = [...given, family].filter(Boolean).join(" ");
  const textName = firstName && typeof firstName.text === "string" ? firstName.text.trim() : "";
  const name = structuredName || textName || id;
  return {
    externalId: `wc|${id}`,
    name,
    ...(typeof patient.birthDate === "string" ? { dateOfBirth: patient.birthDate } : {}),
    role: "employee",
    tenantId: "wc",
    site: "WebChart",
    providerId: "wc-provider-1",
  };
}

/** Build the complete replacement first, then swap the per-worker last-known-good registry once. */
export function replaceLiveDirectory(bundles: readonly unknown[]): readonly EmployeeProfile[] {
  const replacement: EmployeeProfile[] = [];
  for (const bundle of bundles) {
    const patient = firstPatient(bundle);
    if (patient) replacement.push(profileFromPatient(patient));
  }
  liveEmployees = replacement;
  return liveEmployees;
}

export function profileForId(externalId: string): EmployeeProfile | null {
  const cached = liveEmployees.find((employee) => employee.externalId === externalId);
  if (cached) return cached;
  return externalId.startsWith("wc|") ? minimalProfile(externalId) : null;
}

/** Build one immutable lookup view from static rows, the current registry, and persisted wc outcome ids. */
export function directoryForRows(
  rows: readonly { subjectId: string }[],
  webChartConfigured = true,
): DirectorySnapshot {
  if (!webChartConfigured) return STATIC_DIRECTORY;
  const mergedById = new Map<string, EmployeeProfile>(EMPLOYEES.map((employee) => [employee.externalId, employee]));
  for (const employee of liveEmployees) mergedById.set(employee.externalId, employee);
  for (const row of rows) {
    if (row.subjectId.startsWith("wc|") && !mergedById.has(row.subjectId)) {
      mergedById.set(row.subjectId, minimalProfile(row.subjectId));
    }
  }

  if (mergedById.size === EMPLOYEES.length) {
    return STATIC_DIRECTORY;
  }

  const employees = [...mergedById.values()];
  return {
    employees,
    employeeById: (externalId) => mergedById.get(externalId) ?? (externalId.startsWith("wc|") ? minimalProfile(externalId) : null),
    providerById: (id) => id === WEBCHART_PROVIDER.id ? WEBCHART_PROVIDER : staticProviderById(id),
    tenantById: (id) => id === WEBCHART_TENANT.id ? WEBCHART_TENANT : staticTenantById(id),
    enterpriseForTenant: (tenantId) => tenantId === "wc" ? WEBCHART_ENTERPRISE : staticEnterpriseForTenant(tenantId),
  };
}
