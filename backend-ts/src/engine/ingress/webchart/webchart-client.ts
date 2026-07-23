/**
 * WebChart transport seam (E12 PR-2 → PR-2c).
 *
 * PR-2c: the HTTP client now implements WebChart's VERIFIED public FHIR contract
 * (docs/INTEGRATION_RESEARCH_2026-07-13.md, live-checked against the public sandbox 2026-07-13):
 * FHIR R4 JSON at `{baseUrl}/fhir`, population via `GET /fhir/Patient` (searchset `link[next]`
 * paging), and — because the CapabilityStatement exposes NO `Patient/$everything` — each patient's
 * clinical data composed from per-resource `GET /fhir/{type}?patient={id}` searches. Auth is SMART
 * Backend Services (`smart-backend-auth.ts`) when a client id + private key are configured, or the
 * legacy static bearer key otherwise. `_count` + `link[next]` are the standard-FHIR conservative
 * default, but a real WebChart server can reject them: teatea (verified 2026-07-23) 403s a bare
 * `GET /Patient` and 400s `_count`. On a 400/403 first Patient page the client drops `_count` and retries
 * once (for the list AND the per-patient searches); if the server ALSO refuses a bare `/Patient` it does
 * NOT guess a demographic filter (that could silently drop subjects) — it throws an actionable error
 * telling the operator to supply a verified-complete enumeration via `cfg.patientSearch`
 * (`WORKWELL_WEBCHART_PATIENT_SEARCH`, a query verified to return the WHOLE population — e.g. a wide
 * bound like `birthdate=le9999-12-31`, and cross-checked against `Bundle.total`). Pin `cfg.disableCount` /
 * `cfg.patientSearch` up front to skip the probe. Standard servers never hit the fallback.
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
  /**
   * Treat an incomplete population as fatal (authoritative runs). Two behaviors: reject a later Patient
   * page FAILURE instead of returning the pages already fetched, AND throw when the fetch ends with fewer
   * distinct Patients than the searchset's `Bundle.total` (a silent truncation, no page error). The
   * read-only CLI leaves this false and warns instead. Default: false.
   */
  readonly failOnPartialPage?: boolean;
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

class WebChartNonRetryableError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** A bare-`/Patient` 403 or a `_count`-rejecting 400 — the signature that triggers the capability fallback. */
function isCapabilityQuirk(e: unknown): boolean {
  return e instanceof WebChartNonRetryableError && (e.status === 400 || e.status === 403);
}

/** Merge a raw FHIR query string (e.g. `birthdate=le9999-12-31`) into a URL's search params. */
function applyRawQuery(u: URL, rawQuery: string): void {
  for (const [k, v] of new URLSearchParams(rawQuery)) u.searchParams.append(k, v);
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The searchset's advertised match count (`Bundle.total`), when present — used to detect a truncated
 * fetch. Absent or malformed ⇒ undefined (fail-open: a server that omits `total` disables the guard
 * rather than blocking every run), but a present-but-non-numeric `total` is called out so the hole
 * isn't silent (review L3). Verified 2026-07-23: teatea DOES return a numeric `total`.
 */
function bundleTotal(bundle: unknown): number | undefined {
  if (!isObject(bundle)) return undefined;
  const total = bundle.total;
  if (typeof total === "number") return total;
  if (total !== undefined) {
    console.warn(
      `WebChart searchset reported a non-numeric Bundle.total (${typeof total}) — population completeness cannot be verified for this fetch.`,
    );
  }
  return undefined;
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
    if (!isObject(entry)) continue;
    // Only `match`-mode entries are population members (mirrors resourcesFromSearchset's rule). An
    // `_include`/`_revinclude`d Patient — a linked record, a server that includes by default, or an
    // operator-supplied `patientSearch` carrying `_include=` — is NOT a subject. Admitting it would both
    // evaluate a non-member AND inflate the fetched count, masking a genuine shortfall from the
    // completeness guard below (review H2). `Bundle.total` counts matches only, so the two must agree.
    const mode = isObject(entry.search) ? entry.search.mode : undefined;
    if (typeof mode === "string" && mode !== "match") continue;
    const resource = entry.resource;
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
  const failOnPartialPage = options?.failOnPartialPage ?? false;
  const maxRetries = Math.max(0, Math.floor(options?.maxRetries ?? DEFAULT_MAX_RETRIES));
  const retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = Math.max(1, Math.floor(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const resourceTypes = options?.resourceTypes ?? COMPOSED_RESOURCE_TYPES;
  const auth = authProviderFor(cfg, fetchImpl, timeoutMs);

  // Server-capability profile — adaptive by default, or pinned via cfg. `countDisabled` governs BOTH
  // the Patient list and the per-patient searches; `patientEnumeration` is the extra query the
  // Patient-list root carries. Both start from explicit cfg and may be set once by the first-page
  // fallback in listPopulation (which runs before any per-patient search, so the flag is settled).
  let countDisabled = cfg.disableCount ?? false;
  let patientEnumeration = cfg.patientSearch?.trim() || undefined;

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
          throw shouldRetryStatus(response.status) ? new Error(message) : new WebChartNonRetryableError(message, response.status);
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

  /** The Patient-list root URL for the current capability profile. */
  function patientListUrl(): string {
    const u = fhirUrl(base, "/fhir/Patient");
    if (patientEnumeration) applyRawQuery(u, patientEnumeration);
    if (!countDisabled) u.searchParams.set("_count", String(pageSize));
    return u.toString();
  }

  /**
   * When no explicit patientSearch is configured, turn a `_count`/bare-`/Patient` rejection into an
   * ACTIONABLE error instead of silently substituting a demographic guess. A guess like
   * `birthdate=gt1900-01-01` can drop patients (verified on teatea: it returns 28 of 35 — it misses
   * records born on/before 1900-01-01, incl. default/garbage birthdates), and `listPopulation` can only
   * detect a paging shortfall, not a query that under-matches — so an authoritative run would silently
   * miss subjects (Codex P1 #328). Completeness is the operator's to own via
   * `WORKWELL_WEBCHART_PATIENT_SEARCH`; `Group/$export` is the only provably-complete enumeration.
   */
  function enumerationRequired(e: unknown): WebChartNonRetryableError | undefined {
    if (patientEnumeration) return undefined; // the operator's own query failed — that's a real error
    const status = e instanceof WebChartNonRetryableError ? e.status : undefined;
    return new WebChartNonRetryableError(
      `WebChart rejected 'Patient?_count' and a bare 'GET /Patient'${status ? ` (status ${status})` : ""}. ` +
        `This server requires a narrowing Patient search: set WORKWELL_WEBCHART_PATIENT_SEARCH to a query ` +
        `you have verified returns the WHOLE population (compare its Bundle.total; e.g. a wide bound like ` +
        `'birthdate=le9999-12-31', not 'gt1900-01-01' which drops early/default birthdates).`,
    );
  }

  /**
   * Fetch the first Patient page, handling the capability quirk. Attempt 1 is the standard (or pinned)
   * shape. On a 400/403 quirk we retry ONCE with `_count` dropped (any explicit patientSearch stays
   * applied) — never auto-injecting a demographic filter. If the server still refuses (it also 403s a
   * bare `/Patient`) and no patientSearch was configured, throw the actionable error above; any non-quirk
   * failure is a real outage and propagates loudly (review P3-2).
   */
  async function fetchFirstPopulationPage(): Promise<unknown> {
    try {
      return await fetchJson(patientListUrl());
    } catch (e) {
      if (!isCapabilityQuirk(e)) throw e;
      if (!countDisabled) {
        countDisabled = true; // also drops `_count` from the per-patient searches
        try {
          return await fetchJson(patientListUrl());
        } catch (e2) {
          if (isCapabilityQuirk(e2)) throw enumerationRequired(e2) ?? e2;
          throw e2;
        }
      }
      // `_count` was already off (explicit disableCount) and the search still failed.
      throw enumerationRequired(e) ?? e;
    }
  }

  async function listPopulation(): Promise<PatientRef[]> {
    let page = await fetchFirstPopulationPage();
    // Capture the searchset's advertised match count BEFORE the paging loop reassigns `page`.
    const reportedTotal = bundleTotal(page);
    // `url` reflects the profile actually used (countDisabled may have flipped) so relative `link[next]`
    // resolution + the off-origin guard stay correct.
    let url: string | undefined = patientListUrl();

    const patients: PatientRef[] = [];
    const seen = new Set<string>();
    let matchEntries = 0; // match-mode Patient entries seen BEFORE dedup — separates truncation from repeats
    let pages = 0;
    for (;;) {
      pages++;
      const pageMatches = patientsFromSearchset(page);
      matchEntries += pageMatches.length;
      for (const patient of pageMatches) {
        if (!seen.has(patient.id)) {
          seen.add(patient.id);
          patients.push(patient);
        }
      }
      const next = resolveNext(page, url!); // off-origin links throw (outside the fetch try) — never followed
      if (!next) break;
      url = next;
      try {
        page = await fetchJson(url);
      } catch (e) {
        // A failed LATER page keeps the patients already listed (the read-only CLI contract); an
        // authoritative caller opts into failOnPartialPage to reject a truncated population instead.
        if (failOnPartialPage) throw e;
        break;
      }
    }

    // Completeness guard: the searchset advertises how many Patients matched. If we fetched fewer, a page
    // was silently dropped/truncated — on an authoritative run that's an incomplete population, not a
    // success (a partial run would wrongly close out cases for the missing subjects), so fail loudly.
    // The message carries match-entries vs deduped vs total vs pages so an operator can tell a genuine
    // truncation from cross-page repeats or an estimated `total` at a glance (review M1).
    // NOTE: `total` counts the QUERY's matches, so this cannot detect that the enumeration query itself
    // excludes patients (e.g. a `birthdate=` bound missing a record with no/sentinel birthDate) — see
    // docs/DEPLOY.md for the residual gap and the bulk-export follow-up.
    if (typeof reportedTotal === "number") {
      const detail = `${patients.length} distinct (${matchEntries} match entr${matchEntries === 1 ? "y" : "ies"} across ${pages} page(s)) of ${reportedTotal} reported`;
      if (patients.length < reportedTotal) {
        const msg = `WebChart population incomplete: fetched ${detail}.`;
        if (failOnPartialPage) throw new WebChartNonRetryableError(msg);
        console.warn(msg);
      } else if (patients.length > reportedTotal) {
        // More distinct subjects than the server said matched — a non-conformant searchset (or entries
        // that slipped the match-mode filter). Never fatal, but it means the guard can't be trusted here.
        console.warn(`WebChart population over-reported: fetched ${detail} — completeness cannot be verified.`);
      }
    }
    return patients;
  }

  /** All pages of `GET /fhir/{resourceType}?patient={id}` — STRICT: any page failure throws. */
  async function searchResources(resourceType: string, patientId: string): Promise<Json[]> {
    const first = fhirUrl(base, `/fhir/${resourceType}`);
    first.searchParams.set("patient", patientId);
    if (!countDisabled) first.searchParams.set("_count", String(pageSize));
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
