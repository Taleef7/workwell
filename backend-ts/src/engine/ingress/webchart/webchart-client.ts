/**
 * WebChart transport seam (E12 PR-2 → PR-2c).
 *
 * PR-2c: the HTTP client now implements WebChart's VERIFIED public FHIR contract
 * (docs/INTEGRATION_RESEARCH_2026-07-13.md, live-checked against the public sandbox 2026-07-13):
 * FHIR R4 JSON at `{baseUrl}/fhir`, population via `GET /fhir/Patient` (searchset `link[next]`
 * paging), and — because the CapabilityStatement exposes NO `Patient/$everything` — each patient's
 * clinical data composed from per-resource `GET /fhir/{type}?patient={id}` searches. Auth is SMART
 * Backend Services (`smart-backend-auth.ts`) when a client id + private key are configured, or the
 * legacy static bearer key otherwise. Pagination semantics remain unverified with MIE (#254 A2), so
 * `_count` + `link[next]` are standard-FHIR conservative.
 *
 * No new dependency: HTTP uses the global `fetch`; signing uses WebCrypto. Transport lives here at
 * the ingress edge, keeping `evaluate-bundle.ts` / `normalize.ts` I/O-free and portable.
 */
import type { WebChartConfig } from "../data-source.ts";
import { smartBackendServicesAuth, staticBearerAuth, type WebChartAuthProvider } from "./smart-backend-auth.ts";

/** Yields one raw per-patient payload per element (a FHIR Bundle or resource list — normalized upstream). */
export interface WebChartClient {
  readonly kind: string;
  fetchPatientPayloads(): Promise<unknown[]>;
}

/** In-memory client for tests + offline fixtures — the transport-agnostic core runs against this. */
export function fixtureWebChartClient(payloads: unknown[]): WebChartClient {
  return { kind: "fixture", fetchPatientPayloads: () => Promise.resolve(payloads) };
}

export interface HttpWebChartClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly pageSize?: number;
  readonly maxRetries?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly timeoutMs?: number;
  /** Per-patient resource searches composed into the bundle. Default: COMPOSED_RESOURCE_TYPES. */
  readonly resourceTypes?: readonly string[];
}

type Json = Record<string, unknown>;

interface PatientRef {
  readonly id: string;
  readonly resource: Json;
}

/**
 * The clinical resource types composed per patient (no `$everything` on the real contract). The
 * normalizer consumes Observation/Procedure/Immunization events + Condition enrollment/exemptions;
 * Encounter feeds the eCQM qualifying-visit CQL.
 */
export const COMPOSED_RESOURCE_TYPES = ["Observation", "Condition", "Procedure", "Immunization", "Encounter"] as const;

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAYS_MS = [50, 100] as const;
const DEFAULT_TIMEOUT_MS = 10_000;

class WebChartNonRetryableError extends Error {}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fhirUrl(base: string, path: string): URL {
  return new URL(`${base}${path}`);
}

function nextLink(bundle: unknown): string | undefined {
  if (!isObject(bundle) || !Array.isArray(bundle.link)) return undefined;
  for (const link of bundle.link) {
    if (isObject(link) && link.relation === "next" && typeof link.url === "string") return link.url;
  }
  return undefined;
}

function patientsFromSearchset(bundle: unknown): PatientRef[] {
  if (!isObject(bundle) || bundle.resourceType !== "Bundle" || !Array.isArray(bundle.entry)) return [];
  const patients: PatientRef[] = [];
  for (const entry of bundle.entry) {
    const resource = isObject(entry) ? entry.resource : undefined;
    if (isObject(resource) && resource.resourceType === "Patient" && typeof resource.id === "string") {
      patients.push({ id: resource.id, resource });
    }
  }
  return patients;
}

/** `Patient/{id}` reference match — accepts relative and absolute reference forms. */
function referencesPatient(resource: Json, patientId: string): boolean | undefined {
  const holder = isObject(resource.subject) ? resource.subject : isObject(resource.patient) ? resource.patient : undefined;
  if (!holder || typeof holder.reference !== "string") return undefined; // unverifiable — caller keeps it
  return holder.reference === `Patient/${patientId}` || holder.reference.endsWith(`/Patient/${patientId}`);
}

/**
 * Match-mode resources of one searchset page (review P2-3): non-`match` entries (`search.mode`
 * "include"/"outcome") are skipped, as are OperationOutcome (this client's own degraded-patient
 * marker) and Patient resources (the composed bundle must carry exactly one patient). A resource
 * whose subject/patient reference points at a DIFFERENT patient is a hard error — mis-attributed
 * clinical data must degrade the patient (strict semantics), never evaluate as theirs.
 */
function resourcesFromSearchset(bundle: unknown, patientId: string): Json[] {
  if (!isObject(bundle) || bundle.resourceType !== "Bundle") {
    throw new Error("WebChart resource search returned a non-Bundle response");
  }
  if (!Array.isArray(bundle.entry)) return [];
  const resources: Json[] = [];
  for (const entry of bundle.entry) {
    if (!isObject(entry)) continue;
    const mode = isObject(entry.search) ? entry.search.mode : undefined;
    if (typeof mode === "string" && mode !== "match") continue;
    const resource = entry.resource;
    if (!isObject(resource)) continue;
    if (resource.resourceType === "OperationOutcome" || resource.resourceType === "Patient") continue;
    if (referencesPatient(resource, patientId) === false) {
      throw new Error(`WebChart search for patient ${patientId} returned a resource attributed to a different patient`);
    }
    resources.push(resource);
  }
  return resources;
}

function patientFallbackBundle(patient: PatientRef, message: string): unknown {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: patient.resource },
      {
        resource: {
          resourceType: "OperationOutcome",
          issue: [{ severity: "warning", code: "processing", diagnostics: message }],
        },
      },
    ],
  };
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(opts: Required<Pick<HttpWebChartClientOptions, "retryDelaysMs">>, attempt: number): number {
  return opts.retryDelaysMs[Math.min(attempt, opts.retryDelaysMs.length - 1)] ?? 0;
}

function authProviderFor(cfg: WebChartConfig, fetchImpl: typeof globalThis.fetch, timeoutMs: number): WebChartAuthProvider {
  if (cfg.clientId && cfg.privateKeyPem) {
    return smartBackendServicesAuth(
      {
        fhirBase: `${cfg.baseUrl.replace(/\/+$/, "")}/fhir`,
        clientId: cfg.clientId,
        privateKeyPem: cfg.privateKeyPem,
        ...(cfg.tokenUrl ? { tokenUrl: cfg.tokenUrl } : {}),
        ...(cfg.scope ? { scope: cfg.scope } : {}),
        ...(cfg.kid ? { kid: cfg.kid } : {}),
      },
      { fetch: fetchImpl, timeoutMs },
    );
  }
  if (cfg.apiKey) return staticBearerAuth(cfg.apiKey);
  throw new Error("WebChart client requires either an apiKey or a clientId + privateKeyPem");
}

/**
 * Live HTTP client for the verified WebChart FHIR contract (see module doc). One returned payload
 * always represents at most one patient. Any per-resource fetch failure degrades that patient to a
 * Patient-only bundle with an OperationOutcome marker (⇒ MISSING_DATA downstream, never partial-data
 * compliance); `evaluateBatch` keeps per-item isolation and the CQL engine remains the sole outcome
 * authority (ADR-008).
 */
export function httpWebChartClient(cfg: WebChartConfig, options?: HttpWebChartClientOptions): WebChartClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const pageSize = Math.max(1, Math.floor(options?.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxRetries = Math.max(0, Math.floor(options?.maxRetries ?? DEFAULT_MAX_RETRIES));
  const retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = Math.max(1, Math.floor(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const resourceTypes = options?.resourceTypes ?? COMPOSED_RESOURCE_TYPES;
  const auth = authProviderFor(cfg, fetchImpl, timeoutMs);

  async function fetchJson(url: string): Promise<unknown> {
    let attempt = 0;
    let retried401 = false;
    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`WebChart request timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        const headers = {
          Accept: "application/fhir+json, application/json",
          Authorization: await auth.authorizationHeader(),
        };
        const response = await fetchImpl(url, { headers, signal: controller.signal });
        if (response.status === 401 && !retried401) {
          // An expired/revoked token: mint a fresh one and retry once (does not consume a retry attempt).
          retried401 = true;
          auth.invalidate();
          continue;
        }
        if (!response.ok) {
          if (shouldRetryStatus(response.status) && attempt < maxRetries) {
            await delay(retryDelay({ retryDelaysMs }, attempt));
            attempt++;
            continue;
          }
          const message = `WebChart request failed: ${response.status} ${response.statusText}`.trim();
          throw shouldRetryStatus(response.status) ? new Error(message) : new WebChartNonRetryableError(message);
        }
        return await response.json();
      } catch (e) {
        if (e instanceof WebChartNonRetryableError) throw e;
        if (attempt < maxRetries) {
          await delay(retryDelay({ retryDelaysMs }, attempt));
          attempt++;
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * Security (Codex P1, preserved from the mock client): never follow a pagination link off the
   * configured WebChart origin — requests attach the bearer token, so an off-origin link would leak
   * it. The base URL is parsed lazily (not at construction) so a dummy/unparseable base only fails on
   * the fetch path.
   */
  function resolveNext(page: unknown, currentUrl: string): string | undefined {
    const next = nextLink(page);
    if (!next) return undefined;
    const resolved: URL = new URL(next, currentUrl);
    const baseOrigin = new URL(base).origin;
    if (resolved.origin !== baseOrigin) {
      throw new WebChartNonRetryableError(
        `WebChart pagination link points off-origin (expected ${baseOrigin}, got ${resolved.origin}): refusing to follow ${resolved.toString()}`,
      );
    }
    return resolved.toString();
  }

  async function listPopulation(): Promise<PatientRef[]> {
    const first = fhirUrl(base, "/fhir/Patient");
    first.searchParams.set("_count", String(pageSize));
    const patients: PatientRef[] = [];
    let url: string | undefined = first.toString();
    const seen = new Set<string>();
    let firstPage = true;
    while (url) {
      let page: unknown;
      try {
        page = await fetchJson(url);
      } catch (e) {
        // A FIRST-page failure is an outage, not an empty population — surface it so a scheduled
        // run fails loudly instead of "succeeding" over zero subjects (review P3-2). A failed LATER
        // page keeps the patients already listed (documented population semantics); the off-origin
        // guard below still rejects hard.
        if (firstPage) throw e;
        break;
      }
      firstPage = false;
      for (const patient of patientsFromSearchset(page)) {
        if (!seen.has(patient.id)) {
          seen.add(patient.id);
          patients.push(patient);
        }
      }
      url = resolveNext(page, url);
    }
    return patients;
  }

  /** All pages of `GET /fhir/{resourceType}?patient={id}` — STRICT: any page failure throws. */
  async function searchResources(resourceType: string, patientId: string): Promise<Json[]> {
    const first = fhirUrl(base, `/fhir/${resourceType}`);
    first.searchParams.set("patient", patientId);
    first.searchParams.set("_count", String(pageSize));
    const resources: Json[] = [];
    let url: string | undefined = first.toString();
    while (url) {
      const page = await fetchJson(url);
      resources.push(...resourcesFromSearchset(page, patientId));
      url = resolveNext(page, url);
    }
    return resources;
  }

  async function fetchPatient(patient: PatientRef): Promise<unknown> {
    try {
      const resources: Json[] = [];
      // Dedupe across pages/searches by type+id (review P2-2): an offset-paging boundary can repeat a
      // resource, and a duplicated Immunization would double-count doses — flipping a
      // series-completion measure to falsely COMPLIANT. Resources without a string id are kept as-is.
      const seenIds = new Set<string>();
      for (const resourceType of resourceTypes) {
        for (const resource of await searchResources(resourceType, patient.id)) {
          if (typeof resource.id === "string" && resource.id) {
            const key = `${String(resource.resourceType)}/${resource.id}`;
            if (seenIds.has(key)) continue;
            seenIds.add(key);
          }
          resources.push(resource);
        }
      }
      return {
        resourceType: "Bundle",
        type: "collection",
        entry: [{ resource: patient.resource }, ...resources.map((resource) => ({ resource }))],
      };
    } catch (e) {
      // Partial clinical data must never evaluate (a missing Condition/Observation page could flip an
      // outcome) — the whole patient degrades to the fallback bundle and reads MISSING_DATA downstream.
      const message = e instanceof Error ? e.message : String(e);
      return patientFallbackBundle(patient, message);
    }
  }

  return {
    kind: "http",
    async fetchPatientPayloads(): Promise<unknown[]> {
      const patients = await listPopulation();
      const payloads: unknown[] = [];
      for (const patient of patients) payloads.push(await fetchPatient(patient));
      return payloads;
    },
  };
}
