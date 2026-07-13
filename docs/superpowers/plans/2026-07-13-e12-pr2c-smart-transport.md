# E12 PR-2c — SMART Backend Services WebChart transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Handoff note (2026-07-13):** this plan may be executed across model sessions (Fable → Codex/Grok).
> Each task ends in a commit; pick up from the first unchecked step. Branch:
> `feat/e12-pr2c-smart-transport` off `origin/main`. Contract source of truth:
> `docs/INTEGRATION_RESEARCH_2026-07-13.md` §1 (live-verified 2026-07-13).

**Goal:** Rewrite `httpWebChartClient` from the #255 mock contract (static bearer API key + `Patient/$everything`) to WebChart's real, publicly documented contract: SMART Backend Services auth (RS384 `private_key_jwt` → `client_credentials` token) and per-resource `?patient={id}` composition (there is no `$everything`).

**Architecture:** A new portable `smart-backend-auth.ts` module (WebCrypto only — mirrors `auth/password.ts`; NO `node:crypto`, NO new deps) produces `Authorization` header values behind a tiny `WebChartAuthProvider` interface; `webchart-client.ts` swaps its hardcoded bearer header for that provider and replaces the `$everything` per-patient fetch with paged per-resource searches composed into one collection Bundle per patient. Legacy static-bearer mode is kept (fixtures/tests/possible proxies); SMART mode is selected when client-id + private-key env vars are present. Everything stays inert-unless-configured (ADR-017); the CQL engine remains the sole outcome authority (ADR-008).

**Tech Stack:** TypeScript on `@mieweb/cloud`; WebCrypto (`globalThis.crypto.subtle`) for RS384; `node:test` + tsx for tests (`pnpm test` runs `node --import tsx --test "src/**/*.test.ts"`); global `fetch` with injectable shim.

**Verified contract being implemented** (`docs/INTEGRATION_RESEARCH_2026-07-13.md`):

- FHIR base = `{WORKWELL_WEBCHART_BASE_URL}/fhir` (e.g. base `https://<practice>.webchartnow.com/webchart.cgi`) — unchanged from today.
- Discovery: `GET {base}/fhir/.well-known/smart-configuration` → `token_endpoint`.
- Token: `POST token_endpoint` (`application/x-www-form-urlencoded`): `grant_type=client_credentials`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion=<RS384 JWT>`, `scope=system/*.read`. JWT claims: `iss=sub=clientId`, `aud=token_endpoint`, `jti=randomUUID`, `exp=now+300s`, `iat=now`; header `{alg:"RS384", typ:"JWT", kid?}`.
- Data: `GET {base}/fhir/Patient?_count=n` (population, `link[next]` paged) then, per patient, `GET {base}/fhir/{Observation|Condition|Procedure|Immunization|Encounter}?patient={id}&_count=n` (each `link[next]` paged), composed into one `Bundle type:collection` = `[Patient, ...resources]`. JSON only.
- Failure semantics (unchanged philosophy): any per-resource fetch failure after retries ⇒ that patient degrades to the Patient-only fallback bundle + OperationOutcome (⇒ MISSING_DATA downstream; never partial-data compliance). Off-origin `link[next]` refusal now also protects the OAuth token.

---

### Task 1: `smart-backend-auth.ts` — portable SMART Backend Services token client

**Files:**
- Create: `backend-ts/src/engine/ingress/webchart/smart-backend-auth.ts`
- Test: `backend-ts/src/engine/ingress/webchart/smart-backend-auth.test.ts`

Public surface (exact):

```ts
export interface WebChartAuthProvider {
  /** Value for the Authorization header, e.g. "Bearer abc". */
  authorizationHeader(): Promise<string>;
  /** Drop any cached token (called by the client on a 401) — no-op for static mode. */
  invalidate(): void;
}

export function staticBearerAuth(apiKey: string): WebChartAuthProvider;

export interface SmartBackendAuthConfig {
  /** FHIR root, e.g. `${baseUrl}/fhir` — discovery reads `{fhirBase}/.well-known/smart-configuration`. */
  fhirBase: string;
  clientId: string;
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"). RSA; signed RS384. */
  privateKeyPem: string;
  /** Skips discovery when provided. */
  tokenUrl?: string;
  /** Default "system/*.read". */
  scope?: string;
  /** Optional JWK kid header. */
  kid?: string;
}

export interface SmartBackendAuthOptions {
  fetch?: typeof globalThis.fetch;
  /** Injectable clock for tests; default () => Date.now(). */
  now?: () => number;
  /** Refresh this many ms before expiry; default 60_000. */
  expirySkewMs?: number;
}

export function smartBackendServicesAuth(
  cfg: SmartBackendAuthConfig,
  options?: SmartBackendAuthOptions,
): WebChartAuthProvider;
```

Implementation notes (complete):

```ts
// PEM (PKCS#8) → DER bytes. atob is available on node-24 + workers.
function pemToPkcs8(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
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
    "pkcs8", pemToPkcs8(cfg.privateKeyPem).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, false, ["sign"],
  );
  const header: Record<string, unknown> = { alg: "RS384", typ: "JWT", ...(cfg.kid ? { kid: cfg.kid } : {}) };
  const iat = Math.floor(nowMs / 1000);
  const claims = { iss: cfg.clientId, sub: cfg.clientId, aud, jti: crypto.randomUUID(), iat, exp: iat + 300 };
  const signingInput = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}
```

Behavior requirements:
- Discovery result (token_endpoint) memoized per provider instance; `tokenUrl` config bypasses discovery entirely.
- Token POST body is `URLSearchParams` with exactly: `grant_type`, `scope`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion`. Headers: `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`.
- Cache `{accessToken, expiresAtMs}` from `expires_in` (default 300 when absent); refresh when `now() >= expiresAtMs - expirySkewMs`. **Single-flight:** concurrent `authorizationHeader()` calls while a refresh is in flight share one promise; a failed refresh clears the in-flight promise so the next call retries.
- Non-2xx token response, missing `access_token`, or malformed discovery JSON ⇒ throw `Error` with status + a short body snippet (never log the assertion or key).
- `invalidate()` clears the cached token (next call re-fetches).

- [x] **Step 1: Write the failing tests** — `smart-backend-auth.test.ts` (node:test style, mirrors `mock-http-conformance.test.ts` helpers). Generate a real keypair in-test:

```ts
async function testKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
    true, ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}
```

Tests (each with a fetch shim that records requests):
1. `discovery + token exchange: posts a valid RS384 private_key_jwt assertion` — shim serves `.well-known/smart-configuration` `{token_endpoint}` + token endpoint `{access_token:"tok-1",expires_in:3600,token_type:"bearer"}`; assert header `Bearer tok-1`; decode the recorded `client_assertion`: header `{alg:"RS384",typ:"JWT"}`, claims `iss===sub===clientId`, `aud===tokenEndpoint`, `exp-iat===300`, `jti` non-empty; **verify the signature** with `crypto.subtle.verify` against the test public key; assert form fields incl. `client_assertion_type`.
2. `tokenUrl config skips discovery` — shim asserts `.well-known` is never fetched.
3. `token caching: two authorizationHeader() calls → one token request; expiry → refresh` — injectable `now`; advance past `expires_in - skew`; assert second token request + fresh `jti`.
4. `single-flight: concurrent calls share one token request`.
5. `invalidate() forces re-fetch`.
6. `non-2xx token response throws (message carries status, not the assertion)`.

- [x] **Step 2: Run tests, verify they fail** — `cd backend-ts; pnpm test:file src/engine/ingress/webchart/smart-backend-auth.test.ts` (or `node --import tsx --test src/engine/ingress/webchart/smart-backend-auth.test.ts`). Expected: FAIL (module not found).
- [x] **Step 3: Implement `smart-backend-auth.ts`** per the surface + notes above.
- [x] **Step 4: Run tests, verify pass; `pnpm typecheck`.**
- [x] **Step 5: Commit** *(f95d3d8 + tsc fix 3a46876)* — `feat(webchart): SMART Backend Services auth provider (RS384 private_key_jwt, WebCrypto, no deps)`

### Task 2: `webchart-client.ts` — auth provider + per-resource composition

**Files:**
- Modify: `backend-ts/src/engine/ingress/webchart/webchart-client.ts`
- Modify: `backend-ts/src/engine/ingress/webchart/mock-http-conformance.test.ts`

Changes (exact):
1. Replace `commonHeaders` with `authProvider: WebChartAuthProvider` — chosen in `httpWebChartClient` from the (extended, Task 3) `WebChartConfig`: SMART when `clientId && privateKeyPem` (preferred), else static bearer from `apiKey`. `fetchJson` awaits `authProvider.authorizationHeader()` per request; **on a 401 response, call `invalidate()` once and retry immediately** (does not consume a retry attempt; second 401 is terminal for that request).
2. Delete the `$everything` fetch. Add:

```ts
const DEFAULT_RESOURCE_TYPES = ["Observation", "Condition", "Procedure", "Immunization", "Encounter"] as const;

async function searchAll(resourceType: string, patientId: string): Promise<Json[]> {
  // GET {base}/fhir/{resourceType}?patient={id}&_count={pageSize}, link[next]-paged with the
  // SAME off-origin guard as listPopulation (extract the existing loop into a shared
  // `pagedSearch(firstUrl): AsyncGenerator<unknown>` — one guard, two callers), collecting
  // entry[].resource objects (any resourceType — the normalizer filters).
  // UNLIKE listPopulation's page-failure tolerance, a page failure here THROWS (partial
  // clinical data must not evaluate).
}

async function fetchPatient(patient: PatientRef): Promise<unknown> {
  try {
    const resources: Json[] = [];
    for (const rt of resourceTypes) resources.push(...await searchAll(rt, patient.id));
    return { resourceType: "Bundle", type: "collection", entry: [{ resource: patient.resource }, ...resources.map((r) => ({ resource: r }))] };
  } catch (e) {
    return patientFallbackBundle(patient, e instanceof Error ? e.message : String(e));
  }
}
```

3. `HttpWebChartClientOptions` gains `resourceTypes?: readonly string[]` (default above) and `now?: () => number` passthrough for the auth provider.
4. Doc comment: replace the "mock-contract" paragraph with the verified-contract summary + pointer to `docs/INTEGRATION_RESEARCH_2026-07-13.md`.

Conformance-test updates (`mock-http-conformance.test.ts`):
- `devDbHttpFetch` shim: replace the `$everything` route with per-resource routes — for `/fhir/{Observation|Condition|Procedure|Immunization|Encounter}` with `?patient=<id>`, filter the fixture bundle's `entry[]` by `resource.resourceType` and serve a searchset (reuse `searchsetPage` generalized to arbitrary resources; keep `_count`/`_offset` paging on at least Observation to exercise per-resource paging).
- Keep ALL existing test intents, adapted: outcome-parity vs fixture path (the load-bearing test), timeout, 429-then-success (now on a per-resource search), later-population-page failure tolerance, **per-resource failure ⇒ MISSING_DATA while batch continues** (replaces malformed-`$everything`; also keep a malformed-JSON variant), off-origin guard (population `link[next]` AND a per-resource `link[next]`), empty population.
- Add SMART-mode conformance: shim serves `.well-known` + token endpoint (issues `tok-live`), asserts every FHIR request carries `Bearer tok-live` and that exactly **one** token request served the whole batch; cfg `{baseUrl, clientId, privateKeyPem, tokenUrl}`; outcomes must equal the fixture path. Add a 401-once test: first FHIR call 401 ⇒ token re-fetched ⇒ request retried ⇒ batch succeeds.

- [x] **Step 1: Update the shim + tests first, run, verify the new expectations fail** (parity test fails against `$everything` client).
- [x] **Step 2: Implement the client changes.**
- [x] **Step 3: Run the conformance file, verify pass; `pnpm typecheck`.** *(11/11)*
- [x] **Step 4: Commit** *(750b529; WebChartConfig type extension folded in)* — `feat(webchart): per-resource ?patient= composition + SMART auth in httpWebChartClient (no $everything — verified contract)`

### Task 3: config + seam inventory

**Files:**
- Modify: `backend-ts/src/engine/ingress/data-source.ts`
- Modify: `backend-ts/src/engine/ingress/data-source.test.ts` (extend existing)
- Modify: `backend-ts/src/config/seam-inventory.test.ts` (new combination cases)

Changes (exact):

```ts
export interface WebChartConfig {
  baseUrl: string;
  /** Legacy static bearer (kept for fixtures/tests/proxies). */
  apiKey?: string;
  /** SMART Backend Services (preferred when both set). */
  clientId?: string;
  privateKeyPem?: string;
  tokenUrl?: string;
  scope?: string;
}

export interface DataSourceEnv {
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;
  WORKWELL_WEBCHART_CLIENT_ID?: string;
  WORKWELL_WEBCHART_PRIVATE_KEY?: string;   // PKCS#8 PEM (multi-line env value)
  WORKWELL_WEBCHART_TOKEN_URL?: string;
  WORKWELL_WEBCHART_SCOPE?: string;
}

export function isWebChartConfigured(env: DataSourceEnv): boolean {
  const baseUrl = (env.WORKWELL_WEBCHART_BASE_URL ?? "").trim();
  const apiKey = (env.WORKWELL_WEBCHART_API_KEY ?? "").trim();
  const clientId = (env.WORKWELL_WEBCHART_CLIENT_ID ?? "").trim();
  const privateKey = (env.WORKWELL_WEBCHART_PRIVATE_KEY ?? "").trim();
  return Boolean(baseUrl && (apiKey || (clientId && privateKey)));
}
```

`resolveDataSource` passes all trimmed fields through. Tests: baseUrl+clientId+privateKey ⇒ webchart selected; clientId without key ⇒ json; seam-inventory line flips to `webchart=on` for the SMART combination; legacy combination unchanged.

- [x] **Steps: failing tests → implement → pass → `pnpm typecheck` → commit** *(in 750b529)* — `feat(webchart): SMART env contract (CLIENT_ID/PRIVATE_KEY) alongside legacy API_KEY; seam predicate covers both`

### Task 4: docs

**Files:**
- Modify: `docs/WEBCHART_API_ASSUMPTIONS_2026-07.md` (Variant A rewritten to the verified contract — auth = SMART Backend Services; no `$everything`; per-resource composition; pagination still unverified; mark each row Verified-public-docs / Still-assumed)
- Modify: `docs/DEPLOY.md` (env var table: 4 new `WORKWELL_WEBCHART_*` vars, inert-unless-configured)
- Modify: `docs/ARCHITECTURE.md` (§10 seam table `webchart` row: activating env vars becomes "BASE_URL and (API_KEY or CLIENT_ID+PRIVATE_KEY)"; §3 `engine.ingress` paragraph: mock-contract → verified-contract sentence)
- Modify: `docs/DECISIONS.md` (ADR-027: dual-mode WebChart auth — SMART Backend Services per the public contract, preferred; legacy static bearer retained; WebCrypto, no deps; per-resource composition because no `$everything`; whole-patient fallback on any resource failure so partial clinical data never evaluates)
- Modify: `docs/JOURNAL.md` (2026-07-13 entry extended with the PR-2c build)

- [x] **Step: write docs, commit** *(83e452c; ADR number is ADR-028 — 027 was taken)* — `docs(webchart): verified-contract assumptions + ADR-027 + env reference for SMART transport`

### Task 5: verify + review

- [x] `cd backend-ts; pnpm typecheck` — clean.
- [x] `cd backend-ts; pnpm test` — full suite green: **1151 tests, 1150 pass / 0 fail / 1 skipped (pg-skip)** (2026-07-13).
- [ ] Whole-branch code review (superpowers:code-reviewer or Codex) per the standing always-review rule; fix findings; re-run suite. *(Fable adversarial review 2026-07-13: 3 real findings fixed — double-abort listener leak on retry, single-flight cache poisoning across invalidate(), missing branch-vs-main test-count parity check. Codex CLI unavailable in session; re-review with Codex before merge if desired.)*
- [ ] Push branch, open PR referencing #262 (do NOT merge — owner reviews).

### Task 6 (non-code, after Task 5): live sandbox probe

- [x] Live probe done 2026-07-13: R4 4.0.1 + private_key_jwt/RS384 + system/*.read confirmed; grant list advertises authorization_code only. Recorded in INTEGRATION_RESEARCH §1.1a (PR #286). *(Verified live 2026-07-14: R4 4.0.1, token endpoint + `private_key_jwt`/RS384 confirmed, `system/*.read` scope advertised. One deviation: sandbox smart-configuration omits `client_credentials` from grant_types_supported (authorization_code only) — recorded in INTEGRATION_RESEARCH §1.1a; needs MIE confirmation for backend-services on sandbox.)*
- [x] Attempted 2026-07-13: NO registration endpoint openly enabled on the sandbox (none advertised; /register paths fall through to the login UI) → token exchange unreachable without MIE-side registration. Sharpened #254 ask recorded (register a WorkWell backend-services client / enable RFC 7591). *(Attempted 2026-07-14: `POST /webchart.cgi/oauth/register/` = live registration endpoint — returns validation errors for missing fields i.e. endpoint exists and parses; full registration blocked: `software_statement` signed by an MIE-recognized issuer required (`invalid_software_statement`). Token exchange not reachable without registration. Recorded as sharpened #254 ask A3/C13: "issue WorkWell a software statement or register client manually via Login Trusts".)*
- [x] Recorded in INTEGRATION_RESEARCH §1.1a + the #254 answer log (docs branch, PR #286).
