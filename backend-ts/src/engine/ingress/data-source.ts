/**
 * The pluggable patient-data ingress (#184 / E12, FHIR-native-first). A PatientDataSource yields the
 * FHIR bundles to evaluate; the engine derives each subject id from its bundle. JSON-bucket is the
 * default, in-memory, DB-less source. The WebChart source is an INERT stub until E12 PR-2
 * (inert-unless-configured, mirroring resolveForecaster / resolveChannel / resolveStandingOrderProvider).
 * NO DB, NO node:fs here — this stays portable across every @mieweb/cloud target.
 */
import { evaluateBatch, type BatchResult, type EvaluateBundleOptions } from "./evaluate-bundle.ts";
import { normalizeWebChartBundle } from "./webchart/normalize.ts";
import { httpWebChartClient, type WebChartClient } from "./webchart/webchart-client.ts";

export interface PatientDataSource {
  /** Diagnostic tag — "json" | "webchart". */
  readonly kind: string;
  /** The bundles ("bucket") to evaluate. DB-less for the JSON source. */
  loadBundles(): Promise<unknown[]>;
}

/** In-memory JSON bucket: one bundle, an array of bundles, or nothing (→ empty bucket). No DB, no fs. */
export function jsonBucketDataSource(input?: unknown | unknown[]): PatientDataSource {
  const bundles = input === undefined ? [] : Array.isArray(input) ? input : [input];
  return { kind: "json", loadBundles: () => Promise.resolve(bundles) };
}

export interface WebChartConfig {
  baseUrl: string;
  /** Legacy static bearer key (the pre-PR-2c assumption; kept for fixtures/tests/proxies). */
  apiKey?: string;
  /** SMART Backend Services (the verified contract — preferred when both are set). */
  clientId?: string;
  /** PKCS#8 PEM private key for the RS384 client assertion. */
  privateKeyPem?: string;
  /** Token endpoint override; discovered from `{base}/fhir/.well-known/smart-configuration` when absent. */
  tokenUrl?: string;
  /** OAuth scope; default `system/*.rs` (the documented bulk-registration grant). */
  scope?: string;
  /** Optional JWK `kid` header for a multi-key registered JWKS. */
  kid?: string;
  /**
   * Server-capability tuning (adaptive by default). Some WebChart servers reject `_count` and/or a
   * bare `GET /Patient` (teatea rejects both — verified 2026-07-23). `disableCount` pins the client to
   * never send `_count`; `patientSearch` is the raw query the Patient-list root carries so the
   * population is enumerated via an accepted indexed search VERIFIED to return everyone (e.g. the
   * full-range `birthdate=le9999-12-31`; a narrow bound like `gt1900-01-01` silently drops sentinel
   * birthdates). Left
   * unset, the client probes the standard shape and falls back automatically on a 400/403 first page.
   */
  disableCount?: boolean;
  patientSearch?: string;
}

/**
 * WebChart data source (E12 PR-2): fetch per-patient payloads from WebChart's HTTP/FHIR API, then
 * normalize + terminology-reconcile each into an engine bundle. The transport is injectable — the
 * default HTTP client is provisional pending the confirmed API contract (Dave Carlson); tests inject a
 * `fixtureWebChartClient`. Selected only when its env vars are set (inert-unless-configured). The real
 * request shaping lives in `webchart/webchart-client.ts`; the reconciliation/normalization core is
 * transport-agnostic and tested. Descriptive only (ADR-008/ADR-017).
 */
export function webChartDataSource(cfg: WebChartConfig, client?: WebChartClient): PatientDataSource {
  const c = client ?? httpWebChartClient(cfg);
  return {
    kind: "webchart",
    async loadBundles() {
      const payloads = await c.fetchPatientPayloads();
      return payloads.map(normalizeWebChartBundle);
    },
  };
}

export interface DataSourceEnv {
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;
  WORKWELL_WEBCHART_CLIENT_ID?: string;
  /** PKCS#8 PEM (multi-line env value). Prefer the `_B64` form below on a deployed stack. */
  WORKWELL_WEBCHART_PRIVATE_KEY?: string;
  /**
   * Base64 of the WHOLE PKCS#8 PEM file — single-line, and therefore immune to env-var transports
   * that mangle embedded newlines. Takes precedence over the raw form when both are set.
   */
  WORKWELL_WEBCHART_PRIVATE_KEY_B64?: string;
  WORKWELL_WEBCHART_TOKEN_URL?: string;
  WORKWELL_WEBCHART_SCOPE?: string;
  WORKWELL_WEBCHART_KID?: string;
  /** `"true"` pins the client to never send `_count` (for servers that reject it, e.g. teatea). */
  WORKWELL_WEBCHART_DISABLE_COUNT?: string;
  /** Raw Patient-list query for servers that reject a bare `/Patient` (e.g. `birthdate=le9999-12-31`). */
  WORKWELL_WEBCHART_PATIENT_SEARCH?: string;
}

/**
 * The PKCS#8 PEM, from whichever transport form is set — `_B64` wins when both are.
 *
 * A deployed stack should always use `_B64`. A multi-line env value does not survive every container
 * runtime intact: through MIE's Create-a-Container the raw PEM reached the container truncated at its
 * first newline, and WebCrypto rejected the empty body with the opaque `Invalid keyData` (staging,
 * 2026-07-24). Base64 is single-line, so there is no newline to truncate at between the secret store
 * and `crypto.subtle.importKey`.
 *
 * Throws (rather than degrading to inert) when `_B64` is set but unusable: a silent fall-through to
 * synthetic data would look like a working deploy while the live integration was simply off.
 */
export function webChartPrivateKeyFromEnv(env: DataSourceEnv): string | undefined {
  const b64 = (env.WORKWELL_WEBCHART_PRIVATE_KEY_B64 ?? "").trim();
  if (b64) {
    let decoded: string;
    try {
      decoded = atob(b64.replace(/\s+/g, ""));
    } catch {
      throw new Error(
        "WORKWELL_WEBCHART_PRIVATE_KEY_B64 is not valid base64 — set it to the base64 encoding of the whole PKCS#8 PEM file.",
      );
    }
    if (!decoded.includes("BEGIN PRIVATE KEY")) {
      throw new Error(
        "WORKWELL_WEBCHART_PRIVATE_KEY_B64 did not decode to a PKCS#8 PEM (no '-----BEGIN PRIVATE KEY-----') — base64-encode the key FILE, headers included.",
      );
    }
    return decoded;
  }
  return (env.WORKWELL_WEBCHART_PRIVATE_KEY ?? "").trim() || undefined;
}

/**
 * Pure predicate for whether the WebChart source is selected — BASE_URL plus either the legacy
 * API_KEY or the SMART pair (CLIENT_ID + PRIVATE_KEY, the verified contract — PR-2c).
 * The single source of truth for `resolveDataSource` and the boot-time seam inventory (#260).
 *
 * Keyed on the PRESENCE of a private key, not its validity, so a malformed `_B64` still selects the
 * seam and surfaces as the explicit error above instead of silently reading `webchart=off`.
 */
export function isWebChartConfigured(env: DataSourceEnv): boolean {
  const baseUrl = (env.WORKWELL_WEBCHART_BASE_URL ?? "").trim();
  const apiKey = (env.WORKWELL_WEBCHART_API_KEY ?? "").trim();
  const clientId = (env.WORKWELL_WEBCHART_CLIENT_ID ?? "").trim();
  const privateKey =
    (env.WORKWELL_WEBCHART_PRIVATE_KEY_B64 ?? "").trim() || (env.WORKWELL_WEBCHART_PRIVATE_KEY ?? "").trim();
  return Boolean(baseUrl && (apiKey || (clientId && privateKey)));
}

/**
 * The env→WebChartConfig mapping, extracted so callers that must construct the HTTP client with
 * options (the live-evaluate CLI's `--page-size`) share the exact mapping `resolveDataSource`
 * uses. Returns undefined when the seam is not configured.
 */
export function webChartConfigFromEnv(env: DataSourceEnv): WebChartConfig | undefined {
  if (!isWebChartConfigured(env)) return undefined;
  const trimmed = (v?: string) => {
    const t = (v ?? "").trim();
    return t || undefined;
  };
  return {
    baseUrl: (env.WORKWELL_WEBCHART_BASE_URL ?? "").trim(),
    apiKey: trimmed(env.WORKWELL_WEBCHART_API_KEY),
    clientId: trimmed(env.WORKWELL_WEBCHART_CLIENT_ID),
    privateKeyPem: webChartPrivateKeyFromEnv(env),
    tokenUrl: trimmed(env.WORKWELL_WEBCHART_TOKEN_URL),
    scope: trimmed(env.WORKWELL_WEBCHART_SCOPE),
    kid: trimmed(env.WORKWELL_WEBCHART_KID),
    disableCount: (env.WORKWELL_WEBCHART_DISABLE_COUNT ?? "").trim().toLowerCase() === "true" || undefined,
    patientSearch: trimmed(env.WORKWELL_WEBCHART_PATIENT_SEARCH),
  };
}

/**
 * Config-driven ingress selection (mirrors resolveForecaster/resolveChannel): JSON is the default;
 * WebChart is selected only when its env vars are non-blank (inert-unless-configured). The JSON
 * source needs the caller's bundles (inherent to JSON ingress), passed as jsonInput.
 */
export function resolveDataSource(env: DataSourceEnv, jsonInput?: unknown | unknown[]): PatientDataSource {
  const cfg = webChartConfigFromEnv(env);
  if (cfg) return webChartDataSource(cfg);
  return jsonBucketDataSource(jsonInput);
}

/** Evaluate every bundle a source yields against a measure (sugar over loadBundles + evaluateBatch). */
export async function evaluateSource(
  source: PatientDataSource,
  measureId: string,
  opts?: EvaluateBundleOptions,
): Promise<BatchResult> {
  return evaluateBatch(await source.loadBundles(), measureId, opts);
}
