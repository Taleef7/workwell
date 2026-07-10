/**
 * WebChart transport seam (E12 PR-2).
 *
 * The integration path is WebChart's HTTP/FHIR API. The exact endpoints, auth scheme, pagination, and
 * response envelope are being confirmed with Dave Carlson (MIE) — so the transport is isolated behind
 * this small port. The value-carrying core (terminology reconciliation + bundle normalization) is
 * transport-agnostic and fully tested via the fixture client; the confirmed live HTTP client (PR-2c) is
 * then a localized change to `httpWebChartClient` only.
 *
 * No new dependency: the live HTTP client will use the global `fetch` (available on the node-24 host and
 * every @mieweb/cloud target). Transport lives here at the ingress edge, keeping `evaluate-bundle.ts` /
 * `normalize.ts` I/O-free and portable.
 */
import type { WebChartConfig } from "../data-source.ts";

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
}

type Json = Record<string, unknown>;

interface PatientRef {
  readonly id: string;
  readonly resource: Json;
}

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

/**
 * Mock-contract HTTP client (#255 / PR-2c pre-build).
 *
 * Implements the assumed FHIR R4 variant documented in WEBCHART_API_ASSUMPTIONS_2026-07.md:
 * `GET /fhir/Patient?_count=n` paged by FHIR searchset `link[relation=next]`, then
 * `GET /fhir/Patient/{id}/$everything` per patient. One returned payload always represents at most one
 * patient. A bad per-patient fetch degrades to a Patient-only bundle with an OperationOutcome marker, so
 * downstream `evaluateBatch` keeps per-item isolation and the CQL engine remains the sole outcome
 * authority. PR-2c still has to adjust request shaping once MIE confirms the real contract.
 */
export function httpWebChartClient(cfg: WebChartConfig, options?: HttpWebChartClientOptions): WebChartClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const pageSize = Math.max(1, Math.floor(options?.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxRetries = Math.max(0, Math.floor(options?.maxRetries ?? DEFAULT_MAX_RETRIES));
  const retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = Math.max(1, Math.floor(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const commonHeaders = {
    Accept: "application/fhir+json, application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  async function fetchJson(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`WebChart request timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        const response = await fetchImpl(url, { headers: commonHeaders, signal: controller.signal });
        if (!response.ok) {
          if (shouldRetryStatus(response.status) && attempt < maxRetries) {
            await delay(retryDelay({ retryDelaysMs }, attempt));
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
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async function listPopulation(): Promise<PatientRef[]> {
    const first = fhirUrl(base, "/fhir/Patient");
    first.searchParams.set("_count", String(pageSize));
    const patients: PatientRef[] = [];
    let url: string | undefined = first.toString();
    const seen = new Set<string>();
    while (url) {
      let page: unknown;
      try {
        page = await fetchJson(url);
      } catch {
        break;
      }
      for (const patient of patientsFromSearchset(page)) {
        if (!seen.has(patient.id)) {
          seen.add(patient.id);
          patients.push(patient);
        }
      }
      const next = nextLink(page);
      if (!next) {
        url = undefined;
        continue;
      }
      // Security (Codex P1): never follow a pagination link off the configured WebChart origin —
      // fetchJson attaches the bearer API key, so an off-origin link would leak it. The base URL is
      // parsed lazily here (not at construction) so a dummy/unparseable base only fails on the fetch
      // path, exactly as it did before this guard existed.
      const resolved: URL = new URL(next, url);
      const baseOrigin = new URL(base).origin;
      if (resolved.origin !== baseOrigin) {
        throw new WebChartNonRetryableError(
          `WebChart pagination link points off-origin (expected ${baseOrigin}, got ${resolved.origin}): refusing to follow ${resolved.toString()}`,
        );
      }
      url = resolved.toString();
    }
    return patients;
  }

  async function fetchPatient(patient: PatientRef): Promise<unknown> {
    const url = fhirUrl(base, `/fhir/Patient/${encodeURIComponent(patient.id)}/$everything`).toString();
    try {
      return await fetchJson(url);
    } catch (e) {
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
