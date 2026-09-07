/**
 * The corpus as a synthetic DIRECTORY — a `SyntheticDirectoryView`, the exact shape
 * `composeDeploymentDirectory` already consumes, so a Maui deployment can be 20,000 patients instead
 * of the 48-row fixture without anything downstream knowing the difference (spec §4).
 *
 * The generator stays the single source of identity: this maps `CorpusPatient` onto `EmployeeProfile`
 * and derives the provider, tenant and enterprise tables around it. Nothing here invents a person.
 */
import {
  enterpriseForTenant as catalogEnterpriseForTenant,
  tenantById as catalogTenantById,
  type EmployeeProfile,
  type Enterprise,
  type Provider,
  type SyntheticDirectoryView,
  type Tenant,
} from "../employee-catalog.ts";
import { CLINICS, DEFAULT_CORPUS_SEED, PCPS, type CorpusPcp } from "./corpus-parameters.ts";
import { corpusPatients } from "./corpus-patient.ts";

const MAUI_TENANT_ID = "maui";

/**
 * The maui tenant and enterprise rows come from the catalog rather than being restated here: they are
 * the same two rows every other surface resolves, and a second copy would drift silently.
 */
const MAUI_TENANT: Tenant = catalogTenantById(MAUI_TENANT_ID)!;
const MAUI_ENTERPRISE: Enterprise | null = catalogEnterpriseForTenant(MAUI_TENANT_ID);

const providerOf = (pcp: CorpusPcp): Provider => ({ ...pcp, tenantId: MAUI_TENANT_ID });

/**
 * `size` patients from `seed`, plus the 40 PCPs, the clinics they sit at, and the one maui tenant.
 *
 * Generated in one `corpusPatients` pass rather than per-index, because identity disambiguation depends
 * on who came before — see `patientAt`'s note. Callers that want one patient should use `patientAt`.
 */
export function corpusDirectory(seed: string, size: number): SyntheticDirectoryView {
  const patients = corpusPatients(seed, size);
  const EMPLOYEES: readonly EmployeeProfile[] = patients.map((p) => ({
    externalId: p.externalId,
    name: p.name,
    role: "Patient",
    site: p.site,
    providerId: p.providerId,
    tenantId: p.tenantId,
    dateOfBirth: p.dateOfBirth,
    sex: p.sex,
    // No `nationalId`: the pilot has one system, so there is no cross-system person to resolve (spec §3).
  }));
  const PROVIDERS: readonly Provider[] = PCPS.map(providerOf);

  const employeeById = new Map(EMPLOYEES.map((e) => [e.externalId, e]));
  const providerById = new Map(PROVIDERS.map((p) => [p.id, p]));
  // Precomputed rather than filtered per call: the roster and the PCP select both hit this per request,
  // and at 20,000 employees a linear scan per lookup is needless work on a hot path.
  const byLocation = new Map<string, Provider[]>();
  for (const clinic of CLINICS) byLocation.set(clinic.name, []);
  for (const provider of PROVIDERS) byLocation.get(provider.location)?.push(provider);

  return {
    EMPLOYEES,
    PROVIDERS,
    TENANTS: [MAUI_TENANT],
    employeeById: (externalId) => employeeById.get(externalId) ?? null,
    providerById: (id) => providerById.get(id) ?? null,
    tenantById: (id) => (id === MAUI_TENANT_ID ? MAUI_TENANT : null),
    enterpriseForTenant: (tenantId) => (tenantId === MAUI_TENANT_ID ? MAUI_ENTERPRISE : null),
    // The corpus is single-tenant, so this is the whole roster or nothing — never a filter over 20,000.
    employeesForTenant: (tenantId) => (tenantId === MAUI_TENANT_ID ? [...EMPLOYEES] : []),
    providersForLocation: (location) => byLocation.get(location) ?? [],
  };
}

/**
 * The corpus size a deployment is configured for.
 *
 * Defaults to 48 — the fixture prefix — so nothing changes for anyone who has not opted in, and every
 * existing screenshot, saved filter and e2e expectation keeps working. A malformed or non-positive
 * value falls back to the default with a warning rather than throwing: a bad env var should not stop a
 * worker booting, and a silently-huge corpus is worse than a visibly default one.
 */
export const DEFAULT_CORPUS_DIRECTORY_SIZE = 48;

export function corpusSizeFromEnv(env: Record<string, unknown>): number {
  const raw = env.WORKWELL_MAUI_CORPUS_SIZE;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_CORPUS_DIRECTORY_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[workwell] WORKWELL_MAUI_CORPUS_SIZE="${String(raw)}" is not a positive integer; ` +
        `using the default ${DEFAULT_CORPUS_DIRECTORY_SIZE}-patient corpus.`,
    );
    return DEFAULT_CORPUS_DIRECTORY_SIZE;
  }
  return parsed;
}

/** The seed a deployment generates from; the default is the one the manifest and the gate record. */
export function corpusSeedFromEnv(env: Record<string, unknown>): string {
  const raw = env.WORKWELL_MAUI_CORPUS_SEED;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : DEFAULT_CORPUS_SEED;
}
