/**
 * SMART Backend Services auth for the WebChart FHIR transport (E12 PR-2c).
 *
 * WebChart's verified public contract (docs/INTEGRATION_RESEARCH_2026-07-13.md §1.1) authenticates
 * server-to-server clients with SMART Bulk Backend Services: a `client_credentials` grant carrying an
 * RS384 `private_key_jwt` client assertion, verified against the client's registered JWKS. This module
 * produces `Authorization` header values behind the small `WebChartAuthProvider` port; the legacy
 * static-bearer mode is kept for fixtures/tests and any proxy that still fronts the API with a key.
 *
 * Portability: WebCrypto only (`globalThis.crypto.subtle`, mirroring `auth/password.ts`) — no
 * `node:crypto`, no new dependency — so it runs unchanged on the node-24 host and worker targets.
 * Secrets hygiene: the private key and the signed assertion are never logged and never appear in
 * error messages.
 */

export interface WebChartAuthProvider {
  /** Value for the Authorization header, e.g. "Bearer abc". */
  authorizationHeader(): Promise<string>;
  /** Drop any cached token (called by the client on a 401) — no-op for static mode. */
  invalidate(): void;
}

/** Legacy fixed-key mode (the pre-PR-2c assumption; kept for fixtures/tests/proxies). */
export function staticBearerAuth(apiKey: string): WebChartAuthProvider {
  const header = `Bearer ${apiKey}`;
  return {
    authorizationHeader: () => Promise.resolve(header),
    invalidate: () => {},
  };
}

export interface SmartBackendAuthConfig {
  /** FHIR root, e.g. `${baseUrl}/fhir` — discovery reads `{fhirBase}/.well-known/smart-configuration`. */
  fhirBase: string;
  clientId: string;
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"). RSA; signed RS384. */
  privateKeyPem: string;
  /** Skips discovery when provided. */
  tokenUrl?: string;
  /** Default "system/*.rs" — the scope WebChart's documented bulk-client registration grants
   *  (SMART v2 read+search). The sandbox smart-configuration also advertises the v1-style
   *  `system/*.read`; override via config if a deployment is registered with that form. */
  scope?: string;
  /** Optional JWK `kid` header for multi-key JWKS. */
  kid?: string;
}

export interface SmartBackendAuthOptions {
  fetch?: typeof globalThis.fetch;
  /** Injectable clock for tests; default () => Date.now(). */
  now?: () => number;
  /** Refresh this many ms before expiry; default 60_000. */
  expirySkewMs?: number;
  /** Per-request AbortController timeout for the discovery + token fetches; default 10_000 ms. A
   *  black-holed token endpoint must never hang the whole batch (review P2-1). */
  timeoutMs?: number;
}

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const DEFAULT_SCOPE = "system/*.rs";
const ASSERTION_LIFETIME_S = 300;
const DEFAULT_TOKEN_LIFETIME_S = 300;
const DEFAULT_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Smallest plausible PKCS#8 RSA-2048 body; anything shorter is a mangled env value, not a key. */
const MIN_PKCS8_B64_LEN = 512;

/**
 * PEM (PKCS#8) → DER bytes. `atob` exists on node-24 and every worker target.
 *
 * Two transport defenses, both learned from the first staging deploy (2026-07-24), which failed every
 * token request with WebCrypto's opaque `Invalid keyData`:
 *
 *  - **Truncation.** The multi-line PEM did not reach the container intact — an empty/short body
 *    decodes fine and only blows up inside `importKey`, which names neither the variable nor the
 *    cause. The explicit length check below turns that into a message that says what to fix. (The
 *    deployed path now carries the key base64-encoded, so there is no newline left to truncate at.)
 *  - **Escaped newlines.** A separate shape a hand-set env var can take: `\n` surviving as backslash-n.
 *    Those are not whitespace, so `\s+` leaves them in the body. Not what happened in staging — that
 *    fails earlier, in `atob` — but cheap to tolerate and easy to hit.
 */
function pemToPkcs8(pem: string): Uint8Array {
  const unescaped = pem.replace(/\\r\\n|\\n/g, "\n");
  const b64 = unescaped.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (b64.length < MIN_PKCS8_B64_LEN) {
    throw new Error(
      `WebChart private key is not a usable PKCS#8 PEM: only ${b64.length} base64 characters after ` +
        `stripping headers. A multi-line PEM often arrives truncated at the first newline through a ` +
        `container env transport — supply it base64-encoded via WORKWELL_WEBCHART_PRIVATE_KEY_B64.`,
    );
  }
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const utf8 = (s: string) => new TextEncoder().encode(s);

async function signAssertion(cfg: SmartBackendAuthConfig, aud: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(cfg.privateKeyPem).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
    false,
    ["sign"],
  );
  const header: Record<string, unknown> = { alg: "RS384", typ: "JWT", ...(cfg.kid ? { kid: cfg.kid } : {}) };
  const iat = Math.floor(nowMs / 1000);
  const claims = {
    iss: cfg.clientId,
    sub: cfg.clientId,
    aud,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + ASSERTION_LIFETIME_S,
  };
  const signingInput = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

/**
 * A structured OAuth `error` code from an error response body — and ONLY that (Codex P2): the raw
 * body is never included in a thrown message, because a proxy/debug endpoint that echoes form
 * parameters would otherwise put the `client_assertion` JWT into logs/alerts.
 */
function oauthErrorCode(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && typeof parsed.error === "string" && /^[\w-]{1,64}$/.test(parsed.error)) return parsed.error;
  } catch {
    // non-JSON body — discard entirely
  }
  return undefined;
}

export function smartBackendServicesAuth(
  cfg: SmartBackendAuthConfig,
  options?: SmartBackendAuthOptions,
): WebChartAuthProvider {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const now = options?.now ?? (() => Date.now());
  const expirySkewMs = options?.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
  const timeoutMs = Math.max(1, Math.floor(options?.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS));
  const scope = cfg.scope ?? DEFAULT_SCOPE;

  let tokenEndpoint: string | undefined = cfg.tokenUrl;
  let cached: { accessToken: string; expiresAtMs: number } | undefined;
  let inFlight: Promise<string> | undefined;

  /** Every auth fetch is timeout-bounded (its own controller — the single flight is shared across callers). */
  async function boundedFetch(url: string, init: Omit<RequestInit, "signal">): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`WebChart auth request timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function discoverTokenEndpoint(): Promise<string> {
    if (tokenEndpoint) return tokenEndpoint;
    const url = `${cfg.fhirBase.replace(/\/+$/, "")}/.well-known/smart-configuration`;
    const response = await boundedFetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`WebChart SMART discovery failed: ${response.status} ${response.statusText}`.trim());
    }
    const config: unknown = await response.json();
    if (!isObject(config) || typeof config.token_endpoint !== "string" || !config.token_endpoint) {
      throw new Error("WebChart SMART discovery returned no token_endpoint");
    }
    tokenEndpoint = config.token_endpoint;
    return tokenEndpoint;
  }

  async function fetchToken(): Promise<string> {
    const endpoint = await discoverTokenEndpoint();
    const nowMs = now();
    const assertion = await signAssertion(cfg, endpoint, nowMs);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
    });
    const response = await boundedFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const code = oauthErrorCode(text);
      throw new Error(`WebChart token request failed: ${response.status} ${response.statusText}${code ? ` (${code})` : ""}`.trim());
    }
    const payload: unknown = await response.json();
    if (!isObject(payload) || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error("WebChart token response carried no access_token");
    }
    const expiresInS = typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : DEFAULT_TOKEN_LIFETIME_S;
    cached = { accessToken: payload.access_token, expiresAtMs: nowMs + expiresInS * 1000 };
    return payload.access_token;
  }

  return {
    async authorizationHeader(): Promise<string> {
      if (cached && now() < cached.expiresAtMs - expirySkewMs) return `Bearer ${cached.accessToken}`;
      if (!inFlight) {
        // Single-flight: concurrent callers share one refresh; a failure clears it so the next call retries.
        inFlight = fetchToken().finally(() => {
          inFlight = undefined;
        });
      }
      return `Bearer ${await inFlight}`;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
