/**
 * The MCP authorization server end to end through the worker: discovery, registration, authorize, consent,
 * code redemption and refresh, and every refusal on the way.
 *   node --import tsx --test src/routes/oauth.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import worker, { type Env } from "../worker.ts";
import { createJwt } from "../auth/jwt.ts";
import { s256 } from "../auth/oauth/pkce.ts";
import { SqliteAuthFamilyStore } from "../stores/sqlite/auth-family-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";

const SECRET = "o".repeat(48);
const API = "https://api.workwell.test";
const APP = "https://app.workwell.test";
const RESOURCE = `${API}/mcp`;
const CALLBACK = "http://localhost:4123/oauth/callback";
const dbPath = join(tmpdir(), `workwell-oauth-${crypto.randomUUID()}.sqlite`);
const env = { WORKWELL_AUTH_JWT_SECRET: SECRET, WORKWELL_PUBLIC_API_URL: API, WORKWELL_CORS_ALLOWED_ORIGINS: APP } as unknown as Env;
const login = createJwt({ secret: SECRET });
const CM = login.issueAccessToken("cm@workwell.dev", "ROLE_CASE_MANAGER");
const VIEWER = login.issueAccessToken("viewer@workwell.dev", "ROLE_VIEWER");

before(async () => {
  (env as unknown as { DB: unknown }).DB = await createSqliteD1(dbPath);
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${API}${path}`, init), env, {} as never);
const db = () => (env as unknown as { DB: { prepare: (sql: string) => { all: <T>() => Promise<{ results?: T[] }> } } }).DB;

async function register(redirectUris = [CALLBACK]): Promise<string> {
  const res = await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "mcp-remote", redirect_uris: redirectUris }) });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: s256(verifier) };
};

const authorizeUrl = (clientId: string, challenge: string, over: Record<string, string | null> = {}) => {
  const p = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE, scope: "mcp offline_access", state: "st-1" });
  for (const [k, v] of Object.entries(over)) if (v === null) p.delete(k); else p.set(k, v);
  return `/oauth/authorize?${p}`;
};

/** authorize → consent (approved by `bearer`) → the code. */
async function approve(clientId: string, challenge: string, bearer = CM): Promise<{ code: string; redirect: URL }> {
  const auth = await call(authorizeUrl(clientId, challenge), { redirect: "manual" });
  assert.equal(auth.status, 302);
  const consent = new URL(auth.headers.get("location")!);
  assert.equal(consent.origin + consent.pathname, `${APP}/oauth/consent`);
  const request = consent.searchParams.get("request")!;
  const decision = await call("/api/oauth/consent", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ request, decision: "approve" }) });
  assert.equal(decision.status, 200, await decision.clone().text());
  const redirect = new URL(((await decision.json()) as { redirect: string }).redirect);
  return { code: redirect.searchParams.get("code")!, redirect };
}

const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

async function exchange(clientId: string, code: string, verifier: string, over: Record<string, string> = {}) {
  return call("/oauth/token", form({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE, ...over }));
}

const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const mcp = (token: string | null) =>
  call("/mcp", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_META } }),
  });

test("discovery: the protected resource names this server as its authorization server, and the server's metadata is exact", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const prm = (await (await call(path)).json()) as Record<string, unknown>;
    assert.equal(prm.resource, RESOURCE, path);
    assert.deepEqual(prm.authorization_servers, [API]);
    assert.deepEqual(prm.scopes_supported, ["mcp"]);
  }
  const as = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  assert.equal(as.issuer, API, "the issuer is the URL the metadata was fetched from");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.ok(!(as.scopes_supported as string[]).includes("offline_access"));
  assert.equal((await call("/.well-known/openid-configuration")).status, 404, "this is not an OpenID provider");

  const challenge = (await mcp(null)).headers.get("www-authenticate") ?? "";
  assert.match(challenge, /resource_metadata="https:\/\/api\.workwell\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /scope="mcp"/);
});

test("the whole flow: register, authorize, consent, code, /mcp, refresh — and the redirect carries state and iss", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code, redirect } = await approve(clientId, challenge);
  assert.equal(redirect.origin + redirect.pathname, CALLBACK);
  assert.equal(redirect.searchParams.get("state"), "st-1");
  assert.equal(redirect.searchParams.get("iss"), API);

  const tokenRes = await exchange(clientId, code, verifier);
  assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
  assert.equal(tokenRes.headers.get("cache-control"), "no-store");
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 900);
  assert.equal(tokens.scope, "mcp");
  assert.equal((await mcp(tokens.access_token)).status, 200);

  const refreshed = await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
  assert.equal(refreshed.status, 200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(next.refresh_token, tokens.refresh_token, "refresh tokens rotate");
  assert.equal((await mcp(next.access_token)).status, 200);

  const events = (await db().prepare("SELECT event_type AS t, payload_json AS p FROM audit_events WHERE entity_type = 'oauth_grant' ORDER BY id").all<{ t: string; p: string }>()).results!;
  assert.deepEqual(events.map((e) => e.t).slice(-2), ["OAUTH_CONSENT_GRANTED", "OAUTH_TOKEN_ISSUED"]);
  assert.ok(events.every((e) => !e.p.includes(tokens.access_token) && !e.p.includes(tokens.refresh_token)), "no token in the ledger");
});

test("a replayed refresh token revokes the grant, and its access tokens stop working", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await approve(clientId, challenge);
  const first = (await (await exchange(clientId, code, verifier)).json()) as { access_token: string; refresh_token: string };
  const second = (await (await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }))).json()) as { access_token: string; refresh_token: string };
  const third = await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: clientId }));
  assert.equal(third.status, 200, "the chain continues");
  // `first` was rotated away two rotations ago: no longer the "previous" one, so it is a replay.
  const replay = await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }));
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
  assert.equal((await mcp(((await third.json()) as { access_token: string }).access_token)).status, 401, "the grant is revoked");
  const reuse = (await db().prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'OAUTH_REFRESH_REUSE_DETECTED'").all<{ n: number }>()).results!;
  assert.ok(Number(reuse[0]!.n) >= 1);
});

test("two concurrent refreshes from one token: one wins, the other is refused, and the grant survives", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await approve(clientId, challenge);
  const tokens = (await (await exchange(clientId, code, verifier)).json()) as { refresh_token: string };
  const results = await Promise.all([1, 2].map(() => call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }))));
  const ok = results.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, "exactly one refresh wins");
  const winner = (await ok[0]!.json()) as { access_token: string; refresh_token: string };
  assert.equal((await mcp(winner.access_token)).status, 200, "the grant was not revoked by the loser");
  assert.equal((await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: winner.refresh_token, client_id: clientId }))).status, 200);
  // A thief who refreshed first is answered exactly like this loser, so every such refusal is on the ledger.
  const races = (await db().prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'OAUTH_REFRESH_RACE_REFUSED'").all<{ n: number }>()).results!;
  assert.ok(Number(races[0]!.n) >= 1, "the refused race is audited");
});

test("a code is single use: a second redemption is refused and kills the grant, whichever finishes first", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await approve(clientId, challenge);
  const first = await exchange(clientId, code, verifier);
  assert.equal(first.status, 200);
  const tokens = (await first.json()) as { access_token: string };
  assert.equal((await exchange(clientId, code, verifier)).status, 400, "the second use is refused");
  assert.equal((await mcp(tokens.access_token)).status, 401, "and the grant the code produced is revoked");

  // Concurrently: at most one may be issued, and nothing issued survives (RFC 6749 §4.1.2).
  const again = await approve(clientId, challenge);
  const both = await Promise.all([1, 2].map(() => exchange(clientId, again.code, verifier)));
  assert.ok(both.filter((r) => r.status === 200).length <= 1);
  assert.ok(both.some((r) => r.status === 400));
  for (const res of both.filter((r) => r.status === 200)) {
    assert.equal((await mcp(((await res.json()) as { access_token: string }).access_token)).status, 401, "a token from a replayed code does not work");
  }
});

test("the token endpoint refuses a wrong verifier, another client, another redirect, another resource and a missing verifier", async () => {
  const clientId = await register();
  const other = await register();
  const { verifier, challenge } = pkce();
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;
  const { code } = await approve(clientId, challenge);
  assert.equal(await error(await exchange(clientId, code, pkce().verifier)), "invalid_grant", "wrong verifier");
  assert.equal(await error(await exchange(other, code, verifier)), "invalid_grant", "another client");
  assert.equal(await error(await exchange(clientId, code, verifier, { redirect_uri: "http://localhost:4123/other" })), "invalid_grant");
  assert.equal(await error(await exchange(clientId, code, verifier, { resource: "https://elsewhere.test/mcp" })), "invalid_target");
  assert.equal(await error(await exchange(clientId, code, "")), "invalid_grant");
  assert.equal(await error(await call("/oauth/token", form({ grant_type: "password", username: "x", password: "y" }))), "unsupported_grant_type");
  assert.equal((await exchange(clientId, code, verifier)).status, 200, "the right request still redeems it: refusals did not consume the code");
});

test("authorize: an unknown client or redirect gets a page that never redirects or echoes; later errors go back with iss", async () => {
  const clientId = await register();
  const { challenge } = pkce();
  const unknown = await call(authorizeUrl("<script>alert(1)</script>", challenge), { redirect: "manual" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get("location"), null);
  assert.ok(!(await unknown.text()).includes("<script>"), "no parameter is echoed");
  assert.equal(unknown.headers.get("x-frame-options"), "DENY");
  const badRedirect = await call(authorizeUrl(clientId, challenge, { redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
  assert.equal(badRedirect.status, 400);
  assert.equal(badRedirect.headers.get("location"), null);

  const back = async (over: Record<string, string | null>) => {
    const res = await call(authorizeUrl(clientId, challenge, over), { redirect: "manual" });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("location")!);
    assert.equal(to.origin + to.pathname, CALLBACK);
    assert.equal(to.searchParams.get("iss"), API);
    assert.equal(to.searchParams.get("state"), "st-1");
    return to.searchParams.get("error");
  };
  assert.equal(await back({ code_challenge_method: null }), "invalid_request", "no method means plain, which is refused");
  assert.equal(await back({ code_challenge_method: "plain" }), "invalid_request");
  assert.equal(await back({ code_challenge: null }), "invalid_request");
  assert.equal(await back({ resource: null }), "invalid_target");
  assert.equal(await back({ resource: "https://elsewhere.test/mcp" }), "invalid_target");
  assert.equal(await back({ response_type: "token" }), "unsupported_response_type");
  const loopbackPort = await call(authorizeUrl(clientId, challenge, { redirect_uri: "http://localhost:59999/oauth/callback" }), { redirect: "manual" });
  assert.match(loopbackPort.headers.get("location") ?? "", /^https:\/\/app\.workwell\.test\/oauth\/consent\?/, "a loopback redirect may use any port");
});

test("consent: a viewer can read it but not approve; a denial goes back as access_denied; a forged request is refused", async () => {
  const clientId = await register();
  const { challenge } = pkce();
  const auth = await call(authorizeUrl(clientId, challenge), { redirect: "manual" });
  const request = new URL(auth.headers.get("location")!).searchParams.get("request")!;

  const details = (await (await call(`/api/oauth/consent?request=${encodeURIComponent(request)}`, { headers: { authorization: `Bearer ${VIEWER}` } })).json()) as Record<string, unknown>;
  assert.equal(details.clientName, "mcp-remote");
  assert.equal(details.verified, false, "a self-registered client is unverified");
  assert.equal(details.redirectOrigin, "http://localhost:4123");
  assert.equal(details.loopback, true, "the code goes to a program on this computer, so the page warns");
  assert.equal(details.canApprove, false);
  const viewerPost = await call("/api/oauth/consent", { method: "POST", headers: { authorization: `Bearer ${VIEWER}`, "content-type": "application/json" }, body: JSON.stringify({ request, decision: "approve" }) });
  assert.equal(viewerPost.status, 403);
  // The page offers a viewer Decline, and a viewer may never POST: the details carry the decline redirect.
  const declined = new URL(String(details.declineRedirect));
  assert.equal(declined.origin + declined.pathname, CALLBACK);
  assert.equal(declined.searchParams.get("error"), "access_denied");
  assert.equal(declined.searchParams.get("state"), "st-1");
  assert.equal(declined.searchParams.get("iss"), API);
  assert.equal((await call(`/api/oauth/consent?request=${encodeURIComponent(request)}`)).status, 401, "not signed in");

  const deny = await call("/api/oauth/consent", { method: "POST", headers: { authorization: `Bearer ${CM}`, "content-type": "application/json" }, body: JSON.stringify({ request, decision: "deny" }) });
  const denied = new URL(((await deny.json()) as { redirect: string }).redirect);
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("iss"), API);

  const forged = await call("/api/oauth/consent", { method: "POST", headers: { authorization: `Bearer ${CM}`, "content-type": "application/json" }, body: JSON.stringify({ request: `${request}x`, decision: "approve" }) });
  assert.equal(forged.status, 400);
});

// Redeeming the code and making the grant live are one store update, so a store failure there undoes both:
// the retry redeems the code rather than being taken for a replay that revokes the grant.
test("an OAuth access token is refused off /mcp, and a store failure at redemption issues nothing and spends nothing", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await approve(clientId, challenge);
  const proto = SqliteAuthFamilyStore.prototype as unknown as Record<string, unknown>;
  const rotateIf = proto.rotateIf;
  proto.rotateIf = async () => {
    throw new Error("store down: secret detail");
  };
  let down: Response;
  try {
    down = await exchange(clientId, code, verifier);
  } finally {
    proto.rotateIf = rotateIf;
  }
  assert.equal(down.status, 503);
  assert.ok(!(await down.text()).includes("secret detail"));
  const retry = await exchange(clientId, code, verifier);
  assert.equal(retry.status, 200, "the code survived the failure");
  const tokens = (await retry.json()) as { access_token: string };
  assert.equal((await mcp(tokens.access_token)).status, 200, "and the grant it made works");
  for (const path of ["/api/cases", "/api/runs"]) {
    assert.equal((await call(path, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401, path);
  }
});

test("an admin can revoke a connected client from the MCP access list", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await approve(clientId, challenge);
  const tokens = (await (await exchange(clientId, code, verifier)).json()) as { access_token: string };
  const ADMIN = login.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  const list = (await (await call("/api/admin/mcp-tokens", { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { tokens: Array<{ kind: string; tokenId: string; label: string; status: string }> };
  const grant = list.tokens.find((t) => t.kind === "oauth" && t.status === "active" && t.label === "mcp-remote");
  assert.ok(grant, "the connected client is listed");
  assert.equal((await call(`/api/admin/mcp-tokens/${grant!.tokenId}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } })).status, 204);
  // The most recent grant may not be this one; revoke every active grant to be sure this client's is gone.
  for (const t of list.tokens.filter((x) => x.kind === "oauth" && x.status === "active")) {
    await call(`/api/admin/mcp-tokens/${t.tokenId}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } });
  }
  assert.equal((await mcp(tokens.access_token)).status, 401);
});

test("a redirect_uri left out of the authorization request may be left out of the token request, but not one that was sent", async () => {
  const clientId = await register(["http://localhost/oauth/callback"]);
  const { verifier, challenge } = pkce();
  const auth = await call(authorizeUrl(clientId, challenge, { redirect_uri: null }), { redirect: "manual" });
  assert.equal(auth.status, 302);
  const request = new URL(auth.headers.get("location")!).searchParams.get("request")!;
  const decision = await call("/api/oauth/consent", { method: "POST", headers: { authorization: `Bearer ${CM}`, "content-type": "application/json" }, body: JSON.stringify({ request, decision: "approve" }) });
  const redirect = new URL(((await decision.json()) as { redirect: string }).redirect);
  assert.equal(redirect.origin + redirect.pathname, "http://localhost/oauth/callback", "the one registered redirect");
  const code = redirect.searchParams.get("code")!;
  const omitted = await call("/oauth/token", form({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier }));
  assert.equal(omitted.status, 200, await omitted.clone().text());

  // Sent at authorize: required at the token endpoint (the existing flow), so leaving it out is refused.
  const sent = await register();
  const second = pkce();
  const { code: sentCode } = await approve(sent, second.challenge);
  const left = await call("/oauth/token", form({ grant_type: "authorization_code", code: sentCode, client_id: sent, code_verifier: second.verifier }));
  assert.equal(((await left.json()) as { error: string }).error, "invalid_grant");
});

test("resource is compared as a URL: host case, the default port and a trailing slash name the same /mcp", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  for (const resource of ["https://API.workwell.test/mcp", "https://api.workwell.test:443/mcp", `${RESOURCE}/`]) {
    const res = await call(authorizeUrl(clientId, challenge, { resource }), { redirect: "manual" });
    assert.match(res.headers.get("location") ?? "", /^https:\/\/app\.workwell\.test\/oauth\/consent\?/, resource);
  }
  for (const resource of [`${RESOURCE}x`, `${RESOURCE}?a=1`, "https://api.workwell.test:8443/mcp", "http://api.workwell.test/mcp"]) {
    const res = await call(authorizeUrl(clientId, challenge, { resource }), { redirect: "manual" });
    assert.equal(new URL(res.headers.get("location")!).searchParams.get("error"), "invalid_target", resource);
  }
  const { code } = await approve(clientId, challenge);
  assert.equal((await exchange(clientId, code, verifier, { resource: `${RESOURCE}/` })).status, 200);
});

test("registration is bounded: an oversized body or redirect list is refused", async () => {
  const big = await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: [CALLBACK], pad: "x".repeat(20_000) }) });
  assert.equal(big.status, 413);
  const longUris = Array.from({ length: 5 }, (_, i) => `http://localhost/${i}/${"a".repeat(500)}`);
  const long = await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: longUris }) });
  assert.equal(long.status, 400);
  assert.equal(((await long.json()) as { error: string }).error, "invalid_redirect_uri");
  assert.equal((await call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&pad=${"x".repeat(40_000)}` })).status, 413);
});

test("a grant whose code is not yet redeemed is not listed as a connected client", async () => {
  const ADMIN = login.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  const listed = async () =>
    ((await (await call("/api/admin/mcp-tokens", { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { tokens: Array<{ kind: string; tokenId: string; status: string }> }).tokens
      .filter((t) => t.kind === "oauth" && t.status === "active")
      .map((t) => t.tokenId);
  const before = await listed();
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await approve(clientId, challenge);
  assert.deepEqual(await listed(), before, "consented, not yet redeemed: nothing new is connected");
  assert.equal((await exchange(clientId, code, verifier)).status, 200);
  assert.equal((await listed()).length, before.length + 1, "redeemed: now it is");
});

// The ledger is written before the code is spent: if it cannot be written, the code must survive, or the
// client's retry is taken for a replay and the grant is revoked with no record of the redemption.
test("a ledger that cannot be written at redemption answers 503 and leaves the code redeemable", async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await approve(clientId, challenge);
  const proto = SqliteCaseEventStore.prototype as unknown as { appendAudit: (input: { eventType: string }) => Promise<void> };
  const appendAudit = proto.appendAudit;
  proto.appendAudit = async function (this: unknown, input: { eventType: string }) {
    if (input.eventType === "OAUTH_TOKEN_ISSUED") throw new Error("ledger down");
    return appendAudit.call(this, input);
  };
  let down: Response;
  try {
    down = await exchange(clientId, code, verifier);
  } finally {
    proto.appendAudit = appendAudit;
  }
  assert.equal(down.status, 503);
  const retry = await exchange(clientId, code, verifier);
  assert.equal(retry.status, 200, "the retry redeems the code; it is not taken for a replay");
  assert.equal((await mcp(((await retry.json()) as { access_token: string }).access_token)).status, 200);
});
