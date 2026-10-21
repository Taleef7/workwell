/**
 * The OAuth 2.1 authorization server for MCP (MCP 2026-07-28 authorization), on the API's own origin.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   Protected Resource Metadata (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server        Authorization Server Metadata (RFC 8414)
 *   POST /oauth/register                                Dynamic Client Registration (RFC 7591), loopback only
 *   GET  /oauth/authorize                               → the web app's consent page, or an error
 *   POST /oauth/token                                   authorization_code (PKCE S256) and refresh_token
 *   GET  /api/oauth/consent?request=…                   what the consent page shows (signed-in user)
 *   POST /api/oauth/consent { request, decision }       the user's answer → the client's redirect
 *
 * - **Nothing new is stored.** Clients are fetched (CIMD) or self-describing (a signed registration);
 *   the consent request is a signed blob; a grant is one `auth_refresh_families` row (`oauth:<id>`), pending
 *   for its one-time code until redeemed, then live, and moved only through `rotateIf`.
 * - **The login happens in the web app.** The authorize endpoint sends the browser to
 *   `<web app>/oauth/consent`, where the user is signed in as usual and approves with their bearer token.
 *   Only a Case Manager or Admin may approve; the grant carries their role and credential version.
 * - **Tokens.** An access token (15 min, audience = the `/mcp` URL) and a refresh token (30 days, sliding,
 *   at most 90 days for the grant) that rotates on every use; a replayed one revokes the grant (RFC 9700).
 *   The user is re-checked at every refresh (exists on this profile, same credential version, MCP role).
 * - **Audited first.** `OAUTH_CONSENT_GRANTED` before the pending row, `OAUTH_TOKEN_ISSUED` before the code is
 *   redeemed, `OAUTH_REFRESH_REUSE_DETECTED` before the revoke. A store failure answers 503 and issues nothing.
 * - **Bounded.** Client metadata is fetched only for accepted clients (`WORKWELL_OAUTH_CIMD_CLIENTS`, default
 *   Claude's connector and Claude Code; `auth/oauth/cimd.ts`), and request bodies are capped. There is no per-caller rate limit yet
 *   (`docs/MCP.md`, known gaps).
 */
import { randomUUID } from "node:crypto";
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores, type StoresEnv } from "../stores/factory.ts";
import { parseAllowedOrigins } from "../config/cors.ts";
import { mcpResourceOf, publicApiUrl } from "../config/public-api-url.ts";
import { findDemoUser, credentialVersion } from "../auth/demo-users.ts";
import {
  OAUTH_ACCESS_TTL_SECONDS,
  OAUTH_FAMILY_PREFIX,
  OAUTH_GRANT_MAX_SECONDS,
  OAUTH_REFRESH_TTL_SECONDS,
  accountFor,
  isMcpRole,
  oauthPendingGrant,
  readMcpToken,
  signMcpToken,
} from "../auth/mcp-token.ts";
import { nowSeconds } from "../auth/jwt.ts";
import { ClientError, registerClient, resolveClient, type ResolvedClient } from "../auth/oauth/clients.ts";
import { isLoopbackRedirect, redirectMatches, redirectOrigin } from "../auth/oauth/redirect-uris.ts";
import { isS256Challenge, verifierMatches } from "../auth/oauth/pkce.ts";
import { cimdClientsFrom, type CimdDeps } from "../auth/oauth/cimd.ts";

interface Env extends StoresEnv {
  DB: CloudDatabase;
  WORKWELL_AUTH_JWT_SECRET?: string;
  WORKWELL_PUBLIC_API_URL?: string;
  WORKWELL_CORS_ALLOWED_ORIGINS?: string;
  WORKWELL_OAUTH_CIMD_CLIENTS?: string;
}

const CODE_TTL_SECONDS = 60;
const CONSENT_TTL_SECONDS = 600;
const SCOPE = "mcp";
/**
 * A refresh token presented again this soon after it was rotated away is a lost race (a client's parallel
 * requests all refreshing at once), not a replay. Kept short, and every use of it audited, because a thief
 * who refreshed first is answered the same way: the window is all that keeps that from revoking the grant.
 */
const REFRESH_RACE_GRACE_SECONDS = 5;
const REGISTER_BODY_MAX_BYTES = 16 * 1024;
const TOKEN_BODY_MAX_BYTES = 32 * 1024;

/**
 * A grant's row holds `<current refresh jti>~<previous jti>~<rotated at>` in its jti column, so a refresh can
 * tell two concurrent uses of one token (a client's parallel requests all answered 401 at once) from a
 * replay, without a new column. UUIDs never contain `~`.
 */
const packGrant = (current: string, previous = "", rotatedAt = 0): string => `${current}~${previous}~${rotatedAt}`;
const unpackGrant = (value: string): { current: string; previous: string; rotatedAt: number } => {
  const [current = "", previous = "", at = "0"] = value.split("~");
  return { current, previous, rotatedAt: Number(at) || 0 };
};

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
const json = (data: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
const oauthError = (error: string, description: string, status = 400): Response =>
  json({ error, error_description: description }, status, NO_STORE);
const storeDown = (err: unknown): Response => {
  console.error(`[workwell] OAuth store unavailable: ${String((err as Error)?.message ?? err)}`);
  return oauthError("temporarily_unavailable", "the authorization store is unavailable; try again", 503);
};

/** A page for a request that cannot be redirected back. It never echoes a parameter. */
function errorPage(reason: string): Response {
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><title>WorkWell sign-in</title>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#111">
<h1 style="font-size:1.25rem">This sign-in request cannot be completed</h1><p>${reason}</p>
<p>Start again from your MCP client, or connect with a token from WorkWell's Admin page instead.</p></body></html>`;
  return new Response(body, {
    status: 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      ...NO_STORE,
    },
  });
}

/** Where the authorization code (or an error) goes: the registered redirect with `iss` and `state`. */
function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  return url.href;
}

/** The request body as text, or null when it is larger than `limit` bytes (read no further than that). */
async function readBounded(req: Request, limit: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * RFC 8707 resource identifiers compared as URLs: a host's case, a default port and a trailing slash are
 * spellings of the same resource (RFC 3986 §6.2.3), so `https://API.example:443/mcp/` names `/mcp` too.
 */
function sameResource(raw: string | null, resource: string): boolean {
  if (raw === null) return false;
  try {
    const a = new URL(raw);
    const b = new URL(resource);
    const path = (u: URL) => u.pathname.replace(/\/+$/, "");
    return a.origin === b.origin && path(a) === path(b) && !a.search && !a.hash && !a.username && !a.password;
  } catch {
    return false;
  }
}

/** A short reference to a client for the ledger: a CIMD URL as it is, a registration blob by digest. */
async function clientRef(client: ResolvedClient): Promise<string> {
  if (client.trust === "cimd") return client.clientId;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(client.clientId));
  return `dcr:${Buffer.from(digest).toString("base64url").slice(0, 16)}`;
}

interface Ctx {
  env: Env;
  secret: string;
  issuer: string;
  resource: string;
  studio: string;
  cimd: CimdDeps;
}

function protectedResourceMetadata(ctx: Ctx): Response {
  return json(
    { resource: ctx.resource, authorization_servers: [ctx.issuer], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "WorkWell MCP" },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

function authorizationServerMetadata(ctx: Ctx): Response {
  return json(
    {
      issuer: ctx.issuer,
      authorization_endpoint: `${ctx.issuer}/oauth/authorize`,
      token_endpoint: `${ctx.issuer}/oauth/token`,
      registration_endpoint: `${ctx.issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [SCOPE],
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

async function authorize(url: URL, ctx: Ctx): Promise<Response> {
  const p = url.searchParams;
  const clientId = p.get("client_id") ?? "";
  if (!clientId) return errorPage("The request names no client.");
  let client: ResolvedClient;
  try {
    client = await resolveClient(ctx.secret, clientId, ctx.cimd);
  } catch (err) {
    console.warn(`[workwell] OAuth authorize: client refused: ${err instanceof ClientError ? err.message : String(err)}`);
    return errorPage("The client could not be verified.");
  }
  const requested = p.get("redirect_uri");
  const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) return errorPage("The redirect address is not one this client registered.");

  // From here the redirect is trusted, so errors go back to the client (RFC 6749 §4.1.2.1).
  const state = p.get("state") ?? undefined;
  if (state !== undefined && state.length > 1024) return errorPage("The request's state is too long.");
  const back = (error: string, description: string) =>
    Response.redirect(redirectWith(redirectUri, { error, error_description: description, state, iss: ctx.issuer }), 302);
  if (p.get("response_type") !== "code") return back("unsupported_response_type", "only response_type=code is supported");
  const challenge = p.get("code_challenge");
  if (p.get("code_challenge_method") !== "S256" || !isS256Challenge(challenge)) return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
  if (!sameResource(p.get("resource"), ctx.resource)) return back("invalid_target", `resource must be ${ctx.resource}`);

  const request = signMcpToken(
    ctx.secret,
    "consent-request",
    {
      client_id: clientId,
      redirect_uri: redirectUri,
      // Whether the client named it: only then must the token request repeat it (OAuth 2.1 §4.1.3).
      redirect_sent: requested !== null,
      code_challenge: challenge,
      resource: ctx.resource,
      scope: SCOPE,
      ...(state !== undefined ? { state } : {}),
    },
    CONSENT_TTL_SECONDS,
  );
  return Response.redirect(`${ctx.studio}/oauth/consent?request=${encodeURIComponent(request)}`, 302);
}

interface ConsentRequest {
  clientId: string;
  redirectUri: string;
  redirectSent: boolean;
  challenge: string;
  state?: string;
}

function readConsentRequest(ctx: Ctx, raw: unknown): ConsentRequest | null {
  if (typeof raw !== "string") return null;
  const c = readMcpToken(ctx.secret, "consent-request", raw);
  if (!c || typeof c.client_id !== "string" || typeof c.redirect_uri !== "string" || typeof c.code_challenge !== "string") return null;
  if (c.resource !== ctx.resource) return null;
  return {
    clientId: c.client_id,
    redirectUri: c.redirect_uri,
    redirectSent: c.redirect_sent !== false,
    challenge: c.code_challenge,
    ...(typeof c.state === "string" ? { state: c.state } : {}),
  };
}

async function consentDetails(req: Request, ctx: Ctx, actor: string, actorRole: string | null): Promise<Response> {
  const request = readConsentRequest(ctx, new URL(req.url).searchParams.get("request"));
  if (!request) return json({ error: "invalid_request", message: "This sign-in request has expired or is not valid. Start again from your MCP client." }, 400, NO_STORE);
  let client: ResolvedClient;
  try {
    client = await resolveClient(ctx.secret, request.clientId, ctx.cimd);
  } catch {
    return json({ error: "invalid_client", message: "The client could not be verified." }, 400, NO_STORE);
  }
  if (!redirectMatches(client.redirectUris, request.redirectUri)) return json({ error: "invalid_request", message: "The client no longer lists this redirect address." }, 400, NO_STORE);
  return json(
    {
      clientName: client.clientName,
      verified: client.trust === "cimd",
      clientHost: client.host ?? null,
      redirectOrigin: redirectOrigin(request.redirectUri),
      // The code goes to a program on this computer, which no metadata document vouches for: the page warns.
      loopback: isLoopbackRedirect(request.redirectUri),
      scope: SCOPE,
      resource: ctx.resource,
      user: { email: actor, role: actorRole },
      canApprove: isMcpRole(actorRole),
      // Declining changes nothing, so it needs no write: the page sends the browser here. A viewer, who may
      // never POST (the sandbox rule in `auth/authorize.ts`), can still tell the client no.
      declineRedirect: redirectWith(request.redirectUri, { error: "access_denied", error_description: "the user declined", state: request.state, iss: ctx.issuer }),
    },
    200,
    NO_STORE,
  );
}

async function consentDecision(req: Request, ctx: Ctx, actor: string, actorRole: string | null): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { request?: unknown; decision?: unknown } | null;
  const request = readConsentRequest(ctx, body?.request);
  if (!request) return json({ error: "invalid_request", message: "This sign-in request has expired or is not valid." }, 400, NO_STORE);
  let client: ResolvedClient;
  try {
    client = await resolveClient(ctx.secret, request.clientId, ctx.cimd);
  } catch {
    return json({ error: "invalid_client", message: "The client could not be verified." }, 400, NO_STORE);
  }
  if (!redirectMatches(client.redirectUris, request.redirectUri)) return json({ error: "invalid_request" }, 400, NO_STORE);
  const state = request.state;
  if (body?.decision !== "approve") {
    return json({ redirect: redirectWith(request.redirectUri, { error: "access_denied", error_description: "the user declined", state, iss: ctx.issuer }) }, 200, NO_STORE);
  }
  const user = findDemoUser(actor);
  if (!user || !isMcpRole(actorRole) || actorRole !== user.role) {
    return json({ error: "forbidden", message: "Only a Case Manager or Admin can connect an MCP client." }, 403, NO_STORE);
  }

  const codeJti = randomUUID();
  const grant = `${OAUTH_FAMILY_PREFIX}${randomUUID()}`;
  const code = signMcpToken(
    ctx.secret,
    "code",
    {
      sub: user.email,
      role: user.role,
      cv: credentialVersion(user),
      client_id: request.clientId,
      client_name: client.clientName,
      redirect_uri: request.redirectUri,
      redirect_sent: request.redirectSent,
      code_challenge: request.challenge,
      resource: ctx.resource,
      jti: codeJti,
      fam: grant,
    },
    CODE_TTL_SECONDS,
  );
  try {
    const { events, authFamilies } = await getStores(ctx.env);
    // AUDIT BEFORE THE ROW THAT MAKES THE CODE REDEEMABLE: the grant, pending for exactly this code.
    await events.appendAudit({
      eventType: "OAUTH_CONSENT_GRANTED",
      entityType: "oauth_grant",
      entityId: grant.slice(OAUTH_FAMILY_PREFIX.length),
      actor: user.email,
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { grantId: grant.slice(OAUTH_FAMILY_PREFIX.length), client: await clientRef(client), clientName: client.clientName, verified: client.trust === "cimd", redirectOrigin: redirectOrigin(request.redirectUri), role: user.role },
    });
    const now = new Date();
    const codeExpires = new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString();
    await authFamilies.rotate(grant, oauthPendingGrant(codeJti), codeExpires, now.toISOString());
  } catch (err) {
    return storeDown(err);
  }
  return json({ redirect: redirectWith(request.redirectUri, { code, state, iss: ctx.issuer }) }, 200, NO_STORE);
}

async function token(req: Request, ctx: Ctx): Promise<Response> {
  const text = await readBounded(req, TOKEN_BODY_MAX_BYTES).catch(() => "");
  if (text === null) return oauthError("invalid_request", "the request body is too large", 413);
  const p = new URLSearchParams(text);
  const grantType = p.get("grant_type");
  const clientId = p.get("client_id") ?? "";
  const resource = p.get("resource");
  if (resource !== null && !sameResource(resource, ctx.resource)) return oauthError("invalid_target", `resource must be ${ctx.resource}`);
  if (grantType === "authorization_code") return redeemCode(p, clientId, ctx);
  if (grantType === "refresh_token") return refresh(p, clientId, ctx);
  return oauthError("unsupported_grant_type", "grant_type is authorization_code or refresh_token");
}

function tokenResponse(ctx: Ctx, grant: { sub: string; role: string; cv: string; clientId: string; fam: string; gexp: number }, refreshJti: string): { body: Record<string, unknown>; refreshExpiresAt: string } {
  const access = signMcpToken(ctx.secret, "oauth-access", { sub: grant.sub, role: grant.role, cv: grant.cv, aud: ctx.resource, client_id: grant.clientId, fam: grant.fam, scope: SCOPE }, OAUTH_ACCESS_TTL_SECONDS);
  const refreshTtl = Math.max(1, Math.min(OAUTH_REFRESH_TTL_SECONDS, grant.gexp - nowSeconds()));
  const refreshToken = signMcpToken(ctx.secret, "oauth-refresh", { sub: grant.sub, role: grant.role, cv: grant.cv, client_id: grant.clientId, fam: grant.fam, jti: refreshJti, gexp: grant.gexp }, refreshTtl);
  return {
    body: { access_token: access, token_type: "Bearer", expires_in: OAUTH_ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: SCOPE },
    refreshExpiresAt: new Date((nowSeconds() + refreshTtl) * 1000).toISOString(),
  };
}

async function redeemCode(p: URLSearchParams, clientId: string, ctx: Ctx): Promise<Response> {
  const c = readMcpToken(ctx.secret, "code", p.get("code") ?? "");
  if (!c || typeof c.jti !== "string" || typeof c.fam !== "string" || !c.fam.startsWith(OAUTH_FAMILY_PREFIX)) return oauthError("invalid_grant", "the code is not valid");
  if (c.client_id !== clientId) return oauthError("invalid_grant", "the code was issued to another client");
  // Required when the authorization request named it; when it did not, it may be left out (OAuth 2.1 §4.1.3).
  const redirectUri = p.get("redirect_uri");
  if ((c.redirect_sent !== false || redirectUri !== null) && redirectUri !== c.redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (c.resource !== ctx.resource) return oauthError("invalid_target", "the code was issued for another resource");
  if (!verifierMatches(p.get("code_verifier") ?? "", String(c.code_challenge))) return oauthError("invalid_grant", "code_verifier does not match");
  const account = accountFor(c.sub, c.cv, c.role);
  if (!account) return oauthError("invalid_grant", "the account can no longer authorize this client");

  try {
    const { events, authFamilies } = await getStores(ctx.env);
    const now = new Date();
    const grantId = c.fam.slice(OAUTH_FAMILY_PREFIX.length);
    const gexp = nowSeconds() + OAUTH_GRANT_MAX_SECONDS;
    const refreshJti = randomUUID();
    const issued = tokenResponse(ctx, { sub: account.email, role: account.role, cv: String(c.cv), clientId, fam: c.fam, gexp }, refreshJti);
    // AUDIT BEFORE THE CODE IS SPENT: a ledger that cannot be written answers 503 with the code intact, so the
    // client's retry redeems it instead of being taken for a replay. A code that turns out spent leaves this
    // event followed by its OAUTH_CODE_REUSE_DETECTED (an over-claim, never a silent change).
    await events.appendAudit({
      eventType: "OAUTH_TOKEN_ISSUED",
      entityType: "oauth_grant",
      entityId: grantId,
      actor: account.email,
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: {
        grantId,
        client: clientId.startsWith("https://") ? clientId : "dcr",
        clientName: typeof c.client_name === "string" ? c.client_name : "",
        role: account.role,
        subject: account.email,
        expiresAt: new Date(gexp * 1000).toISOString(),
      },
    });
    // The code is the grant row's pending state, so spending it and making the grant live are ONE atomic
    // update: a store failure leaves both undone (503, and the retry redeems the code), and of two concurrent
    // redemptions exactly one moves the row.
    if (await authFamilies.rotateIf(c.fam, oauthPendingGrant(c.jti), packGrant(refreshJti), issued.refreshExpiresAt, now.toISOString())) {
      return json(issued.body, 200, NO_STORE);
    }
    const spent = () => oauthError("invalid_grant", "the code has already been used or has expired");
    // No row: the code lapsed or the grant was revoked; there is nothing to protect.
    if ((await authFamilies.currentJti(c.fam, now.toISOString())) === null) return spent();
    // A live row: this code was redeemed before, so the grant it produced is no longer trustworthy
    // (RFC 6749 §4.1.2). Audited first.
    await events.appendAudit({
      eventType: "OAUTH_CODE_REUSE_DETECTED",
      entityType: "oauth_grant",
      entityId: grantId,
      actor: account.email,
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { grantId },
    });
    await authFamilies.revoke(c.fam);
    return spent();
  } catch (err) {
    return storeDown(err);
  }
}

async function refresh(p: URLSearchParams, clientId: string, ctx: Ctx): Promise<Response> {
  const r = readMcpToken(ctx.secret, "oauth-refresh", p.get("refresh_token") ?? "");
  if (!r || typeof r.jti !== "string" || typeof r.fam !== "string" || !r.fam.startsWith(OAUTH_FAMILY_PREFIX) || typeof r.gexp !== "number") {
    return oauthError("invalid_grant", "the refresh token is not valid");
  }
  if (r.client_id !== clientId) return oauthError("invalid_grant", "the refresh token was issued to another client");
  const account = accountFor(r.sub, r.cv, r.role);
  if (!account) return oauthError("invalid_grant", "the account can no longer authorize this client");
  if (r.gexp <= nowSeconds()) return oauthError("invalid_grant", "the grant has reached its 90-day limit; connect again");

  try {
    const { events, authFamilies } = await getStores(ctx.env);
    const now = new Date();
    const nowIso = now.toISOString();
    const gone = () => oauthError("invalid_grant", "the grant was revoked or has lapsed; connect again");
    let rowValue = await authFamilies.currentJti(r.fam, nowIso);
    if (rowValue === null) return gone();
    let row = unpackGrant(rowValue);
    if (row.current === r.jti) {
      const newJti = randomUUID();
      const issued = tokenResponse(ctx, { sub: account.email, role: account.role, cv: String(r.cv), clientId, fam: r.fam, gexp: r.gexp }, newJti);
      // Atomic: of two concurrent refreshes from this token, one rotates and the other reads the result.
      if (await authFamilies.rotateIf(r.fam, rowValue, packGrant(newJti, r.jti, nowSeconds()), issued.refreshExpiresAt, nowIso)) {
        return json(issued.body, 200, NO_STORE);
      }
      rowValue = await authFamilies.currentJti(r.fam, nowIso);
      if (rowValue === null) return gone();
      row = unpackGrant(rowValue);
    }
    // This token was just rotated away by a concurrent refresh: refuse it, but the grant stays (the client
    // holds the winner's tokens). Audited, since a thief who refreshed first looks exactly like this.
    if (row.previous === r.jti && nowSeconds() - row.rotatedAt <= REFRESH_RACE_GRACE_SECONDS) {
      await events.appendAudit({
        eventType: "OAUTH_REFRESH_RACE_REFUSED",
        entityType: "oauth_grant",
        entityId: r.fam.slice(OAUTH_FAMILY_PREFIX.length),
        actor: account.email,
        refRunId: null,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: { grantId: r.fam.slice(OAUTH_FAMILY_PREFIX.length), secondsSinceRotation: nowSeconds() - row.rotatedAt },
      });
      return oauthError("invalid_grant", "this refresh token was just used; use the newest tokens");
    }
    // Otherwise it was used before: a replay, so the grant is revoked (RFC 9700 §4.14), audited first.
    await events.appendAudit({
      eventType: "OAUTH_REFRESH_REUSE_DETECTED",
      entityType: "oauth_grant",
      entityId: r.fam.slice(OAUTH_FAMILY_PREFIX.length),
      actor: account.email,
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { grantId: r.fam.slice(OAUTH_FAMILY_PREFIX.length) },
    });
    await authFamilies.revoke(r.fam);
    return oauthError("invalid_grant", "the refresh token was already used; the grant is revoked, connect again");
  } catch (err) {
    return storeDown(err);
  }
}

const OAUTH_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/api/oauth/consent",
]);

/** Returns a Response if this module owns the route, else null. `actor`/`actorRole` are the worker's login principal. */
export async function handleOAuth(
  req: Request,
  env: Env,
  opts: { authEnabled: boolean; actor: string; actorRole: string | null; cimd?: CimdDeps },
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!OAUTH_PATHS.has(url.pathname)) {
    if (url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/oauth/")) return json({ error: "not_found" }, 404);
    return null;
  }
  if (!opts.authEnabled) return json({ error: "not_found", message: "OAuth needs WORKWELL_AUTH_JWT_SECRET" }, 404);
  const pub = publicApiUrl(env, req, true);
  if (!pub.ok) return json({ error: "temporarily_unavailable", error_description: pub.reason }, 503);
  const studio = parseAllowedOrigins(env.WORKWELL_CORS_ALLOWED_ORIGINS)[0];
  if (!studio) return json({ error: "temporarily_unavailable", error_description: "no web app origin is configured" }, 503);
  const cimd: CimdDeps = { allowedClients: cimdClientsFrom(env.WORKWELL_OAUTH_CIMD_CLIENTS), ...opts.cimd };
  const ctx: Ctx = { env, secret: env.WORKWELL_AUTH_JWT_SECRET ?? "", issuer: pub.origin, resource: mcpResourceOf(pub.origin), studio, cimd };

  const method = req.method;
  switch (url.pathname) {
    case "/.well-known/oauth-protected-resource":
    case "/.well-known/oauth-protected-resource/mcp":
      return method === "GET" ? protectedResourceMetadata(ctx) : json({ error: "method_not_allowed" }, 405);
    case "/.well-known/oauth-authorization-server":
      return method === "GET" ? authorizationServerMetadata(ctx) : json({ error: "method_not_allowed" }, 405);
    case "/oauth/register": {
      if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const text = await readBounded(req, REGISTER_BODY_MAX_BYTES).catch(() => "");
      if (text === null) return json({ error: "invalid_client_metadata", error_description: "the registration is too large" }, 413, NO_STORE);
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* registerClient refuses a missing body */
      }
      const result = registerClient(ctx.secret, body);
      return json(result.body, result.status, NO_STORE);
    }
    case "/oauth/authorize":
      return method === "GET" ? authorize(url, ctx) : json({ error: "method_not_allowed" }, 405);
    case "/oauth/token":
      return method === "POST" ? token(req, ctx) : json({ error: "method_not_allowed" }, 405);
    case "/api/oauth/consent":
      if (method === "GET") return consentDetails(req, ctx, opts.actor, opts.actorRole);
      if (method === "POST") return consentDecision(req, ctx, opts.actor, opts.actorRole);
      return json({ error: "method_not_allowed" }, 405);
  }
  return null;
}
