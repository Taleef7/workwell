/**
 * The corpus as a synthetic DIRECTORY — the shape `composeDeploymentDirectory` consumes, so a Maui
 * deployment can be 20,000 patients instead of the 48-row fixture without anything downstream knowing
 * the difference (spec §4).
 *
 * The generator stays the single source of identity: this maps `CorpusPatient` onto `EmployeeProfile`
 * and derives the provider and tenant tables around it. Nothing here invents a person.
 */
import type { EmployeeProfile } from "../employee-catalog.ts";
import { CLINICS, PCPS, type CorpusPcp } from "./corpus-parameters.ts";
import { corpusPatients } from "./corpus-patient.ts";

export interface CorpusProvider {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly tenantId: "maui";
}

export interface CorpusDirectory {
  readonly EMPLOYEES: readonly EmployeeProfile[];
  readonly PROVIDERS: readonly CorpusProvider[];
  readonly employeeById: ReadonlyMap<string, EmployeeProfile>;
  readonly providerById: ReadonlyMap<string, CorpusProvider>;
  providersForLocation(location: string): readonly CorpusProvider[];
}

const providerOf = (pcp: CorpusPcp): CorpusProvider => ({ ...pcp, tenantId: "maui" });

/**
 * `size` patients from `seed`, plus the 40 PCPs and the clinics they sit at.
 *
 * Generated in one `corpusPatients` pass rather than per-index, because identity disambiguation depends
 * on who came before — see `patientAt`'s note. Callers that want one patient should use `patientAt`.
 */
export function corpusDirectory(seed: string, size: number): CorpusDirectory {
  const patients = corpusPatients(seed, size);
  const EMPLOYEES: EmployeeProfile[] = patients.map((p) => ({
    externalId: p.externalId,
    name: p.name,
    role: "Patient",
    site: p.site,
    providerId: p.providerId,
    tenantId: p.tenantId,
    dateOfBirth: p.dateOfBirth,
  }));
  const PROVIDERS = PCPS.map(providerOf);

  const employeeById = new Map(EMPLOYEES.map((e) => [e.externalId, e]));
  const providerById = new Map(PROVIDERS.map((p) => [p.id, p]));
  // Precomputed rather than filtered per call: the roster and the PCP select both hit this per request,
  // and at 40 providers a linear scan per lookup is needless work on a hot path.
  const byLocation = new Map<string, CorpusProvider[]>();
  for (const clinic of CLINICS) byLocation.set(clinic.name, []);
  for (const provider of PROVIDERS) byLocation.get(provider.location)?.push(provider);

  return {
    EMPLOYEES,
    PROVIDERS,
    employeeById,
    providerById,
    providersForLocation: (location: string) => byLocation.get(location) ?? [],
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
