/**
 * SMART Backend Services auth provider (E12 PR-2c).
 *   node --import tsx --test src/engine/ingress/webchart/smart-backend-auth.test.ts
 *
 * Contract under test: docs/INTEGRATION_RESEARCH_2026-07-13.md §1.1 — WebChart's token endpoint
 * takes a client_credentials grant with an RS384 private_key_jwt client assertion. Tests generate a
 * real RSA keypair via WebCrypto and VERIFY the assertion signature — no mocked crypto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { smartBackendServicesAuth, staticBearerAuth, type SmartBackendAuthConfig } from "./smart-backend-auth.ts";

type FetchImpl = typeof globalThis.fetch;
type FetchInput = Parameters<FetchImpl>[0];
type FetchInit = Parameters<FetchImpl>[1];

const FHIR_BASE = "https://practice.webchart.test/webchart.cgi/fhir";
const TOKEN_URL = "https://practice.webchart.test/webchart.cgi/oauth/token/";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

interface RecordedTokenRequest {
  url: string;
  form: URLSearchParams;
  contentType: string | undefined;
}

async function testKeyPair() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

function inputUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(init: FetchInit, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()];
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as Record<string, unknown>;
}

/**
 * A fetch shim serving `.well-known/smart-configuration` + the token endpoint. Records every token
 * request; issues tok-1, tok-2, … in order.
 */
function authServerShim(opts?: { failTokenWithStatus?: number; expiresIn?: number | null }) {
  const tokenRequests: RecordedTokenRequest[] = [];
  let discoveryRequests = 0;
  const fetchImpl: FetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const url = inputUrl(input);
    if (url === `${FHIR_BASE}/.well-known/smart-configuration`) {
      discoveryRequests++;
      return new Response(JSON.stringify({ token_endpoint: TOKEN_URL }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : String(init?.body));
      tokenRequests.push({ url, form, contentType: headerValue(init, "Content-Type") });
      if (opts?.failTokenWithStatus) {
        return new Response("denied", { status: opts.failTokenWithStatus });
      }
      const body: Record<string, unknown> = { access_token: `tok-${tokenRequests.length}`, token_type: "bearer" };
      if (opts?.expiresIn !== null) body.expires_in = opts?.expiresIn ?? 3600;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as FetchImpl;
  return {
    fetchImpl,
    tokenRequests,
    get discoveryRequests() {
      return discoveryRequests;
    },
  };
}

function cfgWith(pem: string, overrides?: Partial<SmartBackendAuthConfig>): SmartBackendAuthConfig {
  return { fhirBase: FHIR_BASE, clientId: "workwell-client", privateKeyPem: pem, ...overrides };
}

test("staticBearerAuth returns the fixed header and invalidate is a no-op", async () => {
  const auth = staticBearerAuth("legacy-key");
  assert.equal(await auth.authorizationHeader(), "Bearer legacy-key");
  auth.invalidate();
  assert.equal(await auth.authorizationHeader(), "Bearer legacy-key");
});

test("discovery + token exchange: posts a valid RS384 private_key_jwt assertion", async () => {
  const { pem, publicKey } = await testKeyPair();
  const shim = authServerShim();
  const auth = smartBackendServicesAuth(cfgWith(pem), { fetch: shim.fetchImpl });

  assert.equal(await auth.authorizationHeader(), "Bearer tok-1");
  assert.equal(shim.discoveryRequests, 1);
  assert.equal(shim.tokenRequests.length, 1);

  const req = shim.tokenRequests[0]!;
  assert.match(req.contentType ?? "", /application\/x-www-form-urlencoded/);
  assert.equal(req.form.get("grant_type"), "client_credentials");
  assert.equal(req.form.get("scope"), "system/*.read");
  assert.equal(req.form.get("client_assertion_type"), ASSERTION_TYPE);

  const assertion = req.form.get("client_assertion")!;
  const [headerPart, claimsPart, sigPart] = assertion.split(".") as [string, string, string];
  const header = decodeJwtPart(headerPart);
  const claims = decodeJwtPart(claimsPart);
  assert.equal(header.alg, "RS384");
  assert.equal(header.typ, "JWT");
  assert.equal(claims.iss, "workwell-client");
  assert.equal(claims.sub, "workwell-client");
  assert.equal(claims.aud, TOKEN_URL);
  assert.equal(typeof claims.jti, "string");
  assert.ok((claims.jti as string).length > 0);
  assert.equal((claims.exp as number) - (claims.iat as number), 300);

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    b64urlToBytes(sigPart).buffer as ArrayBuffer,
    new TextEncoder().encode(`${headerPart}.${claimsPart}`),
  );
  assert.equal(verified, true, "assertion signature must verify against the public key");
});

test("tokenUrl config skips discovery entirely", async () => {
  const { pem } = await testKeyPair();
  const shim = authServerShim();
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL }), { fetch: shim.fetchImpl });
  assert.equal(await auth.authorizationHeader(), "Bearer tok-1");
  assert.equal(shim.discoveryRequests, 0);
  assert.equal((decodeJwtPart(shim.tokenRequests[0]!.form.get("client_assertion")!.split(".")[1]!) as { aud: string }).aud, TOKEN_URL);
});

test("kid + custom scope are honored", async () => {
  const { pem } = await testKeyPair();
  const shim = authServerShim();
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL, kid: "key-1", scope: "system/*.rs" }), {
    fetch: shim.fetchImpl,
  });
  await auth.authorizationHeader();
  const req = shim.tokenRequests[0]!;
  assert.equal(req.form.get("scope"), "system/*.rs");
  assert.equal(decodeJwtPart(req.form.get("client_assertion")!.split(".")[0]!).kid, "key-1");
});

test("token caching: repeat calls reuse the token; expiry triggers a refresh with a fresh jti", async () => {
  const { pem } = await testKeyPair();
  const shim = authServerShim({ expiresIn: 120 });
  let nowMs = 1_000_000;
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL }), {
    fetch: shim.fetchImpl,
    now: () => nowMs,
    expirySkewMs: 60_000,
  });

  assert.equal(await auth.authorizationHeader(), "Bearer tok-1");
  assert.equal(await auth.authorizationHeader(), "Bearer tok-1");
  assert.equal(shim.tokenRequests.length, 1, "second call within lifetime must not re-fetch");

  nowMs += 61_000; // past expires_in(120s) - skew(60s)
  assert.equal(await auth.authorizationHeader(), "Bearer tok-2");
  assert.equal(shim.tokenRequests.length, 2);
  const jti1 = decodeJwtPart(shim.tokenRequests[0]!.form.get("client_assertion")!.split(".")[1]!).jti;
  const jti2 = decodeJwtPart(shim.tokenRequests[1]!.form.get("client_assertion")!.split(".")[1]!).jti;
  assert.notEqual(jti1, jti2, "each assertion must carry a fresh jti");
});

test("missing expires_in defaults to a short lifetime (still caches within it)", async () => {
  const { pem } = await testKeyPair();
  const shim = authServerShim({ expiresIn: null });
  let nowMs = 0;
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL }), {
    fetch: shim.fetchImpl,
    now: () => nowMs,
    expirySkewMs: 60_000,
  });
  await auth.authorizationHeader();
  await auth.authorizationHeader();
  assert.equal(shim.tokenRequests.length, 1);
  nowMs += 300_000; // past the 300s default
  await auth.authorizationHeader();
  assert.equal(shim.tokenRequests.length, 2);
});

test("single-flight: concurrent calls share one token request", async () => {
  const { pem } = await testKeyPair();
  const shim = authServerShim();
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL }), { fetch: shim.fetchImpl });
  const headers = await Promise.all([auth.authorizationHeader(), auth.authorizationHeader(), auth.authorizationHeader()]);
  assert.deepEqual(headers, ["Bearer tok-1", "Bearer tok-1", "Bearer tok-1"]);
  assert.equal(shim.tokenRequests.length, 1);
});

test("invalidate() forces a re-fetch on the next call", async () => {
  const { pem } = await testKeyPair();
  const shim = authServerShim();
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL }), { fetch: shim.fetchImpl });
  assert.equal(await auth.authorizationHeader(), "Bearer tok-1");
  auth.invalidate();
  assert.equal(await auth.authorizationHeader(), "Bearer tok-2");
  assert.equal(shim.tokenRequests.length, 2);
});

test("non-2xx token response throws with the status and without leaking the assertion", async () => {
  const { pem } = await testKeyPair();
  const shim = authServerShim({ failTokenWithStatus: 401 });
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL }), { fetch: shim.fetchImpl });
  await assert.rejects(
    () => auth.authorizationHeader(),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /401/);
      assert.doesNotMatch(e.message, /eyJ/, "error must not contain the JWT assertion");
      return true;
    },
  );
  // a failed refresh must not poison the cache — the next call retries
  await assert.rejects(() => auth.authorizationHeader());
  assert.equal(shim.tokenRequests.length, 2);
});

test("discovery failure: a non-200 smart-configuration response throws", async () => {
  const { pem } = await testKeyPair();
  const fetchImpl: FetchImpl = (async () => new Response("down", { status: 503 })) as FetchImpl;
  const auth = smartBackendServicesAuth(cfgWith(pem), { fetch: fetchImpl });
  await assert.rejects(() => auth.authorizationHeader(), /discovery failed: 503/);
});

test("discovery failure: a 200 without token_endpoint throws", async () => {
  const { pem } = await testKeyPair();
  const fetchImpl: FetchImpl = (async () =>
    new Response(JSON.stringify({ authorization_endpoint: "https://x" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as FetchImpl;
  const auth = smartBackendServicesAuth(cfgWith(pem), { fetch: fetchImpl });
  await assert.rejects(() => auth.authorizationHeader(), /token_endpoint/);
});

test("a black-holed token endpoint times out instead of hanging (P2-1)", async () => {
  const { pem } = await testKeyPair();
  const fetchImpl: FetchImpl = ((_input: FetchInput, init?: FetchInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    })) as FetchImpl;
  const auth = smartBackendServicesAuth(cfgWith(pem, { tokenUrl: TOKEN_URL }), { fetch: fetchImpl, timeoutMs: 10 });
  await assert.rejects(() => auth.authorizationHeader(), /timed out/);
});

test("missing access_token in a 2xx response throws", async () => {
  const { pem } = await testKeyPair();
  let served = false;
  const fetchImpl: FetchImpl = (async () => {
    served = true;
    return new Response(JSON.stringify({ token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as FetchImpl;
  const auth = smartBackendServicesAuth(cfgWith((await testKeyPair()).pem, { tokenUrl: TOKEN_URL }), { fetch: fetchImpl });
  await assert.rejects(() => auth.authorizationHeader(), /access_token/);
  assert.equal(served, true);
});
