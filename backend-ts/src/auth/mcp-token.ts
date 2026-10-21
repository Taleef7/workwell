/**
 * MCP access tokens (#704): a credential that is long-lived, revocable one by one, and valid only on `/mcp`.
 *
 * - **A key per kind.** Each kind of token this module signs (a personal access token, and the OAuth kinds
 *   that build on it) has its own HS256 key, derived from `WORKWELL_AUTH_JWT_SECRET` with a label, and its
 *   own header `typ`. A token of one kind therefore cannot verify as another, a login token cannot verify
 *   as any of them, and none of them verifies as a login token (`jwt.ts` also refuses `kind`/`aud`). One
 *   shared key would let a code or a refresh token pass as a bearer token.
 * - **The audience is the MCP endpoint.** MCP 2026-07-28: a server "MUST validate that access tokens were
 *   issued specifically for them" and "MUST NOT accept or transit any other tokens".
 * - **Revocation without a new table.** Each token is one `auth_refresh_families` row (`mcp-pat:<id>` with
 *   the token's jti and expiry). Revoking deletes the row, and the next request is refused.
 * - **The user is checked on every request.** The account must still exist on this profile, with the
 *   credential version the token was minted under (a password change ends every token, as it ends login
 *   sessions), and a role at least the token's.
 * - **A store error fails closed.** It is reported as `McpStoreUnavailableError`, never as a valid token.
 */
import { createHmac, randomUUID } from "node:crypto";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { issueSigned, nowSeconds, verifySigned } from "./jwt.ts";
import { credentialVersion, findDemoUser } from "./demo-users.ts";
import type { AuthFamilyStore } from "../stores/auth-family-store.ts";

export type McpTokenKind = "pat" | "oauth-access" | "oauth-refresh" | "code" | "consent-request" | "client";

const typOf = (kind: McpTokenKind): string => `workwell-mcp+${kind}`;

/** The HS256 key for one kind: HMAC-SHA256(secret, "workwell-mcp-v1/<kind>"). */
export function keyFor(secret: string, kind: McpTokenKind): Buffer {
  return createHmac("sha256", secret).update(`workwell-mcp-v1/${kind}`).digest();
}

export function signMcpToken(secret: string, kind: McpTokenKind, claims: Record<string, unknown>, ttlSeconds: number): string {
  return issueSigned(keyFor(secret, kind), typOf(kind), claims, ttlSeconds);
}

/** The claims of a token of exactly `kind`, or null (wrong kind, key, typ, signature or expiry). */
export function readMcpToken(secret: string, kind: McpTokenKind, token: string): Record<string, unknown> | null {
  return verifySigned(keyFor(secret, kind), token, typOf(kind));
}

/** The roles that may use MCP, lowest first. */
export const MCP_ROLES = ["ROLE_CASE_MANAGER", "ROLE_ADMIN"] as const;
export type McpRole = (typeof MCP_ROLES)[number];

export const isMcpRole = (role: unknown): role is McpRole => MCP_ROLES.includes(role as McpRole);

/** A token may carry the user's own MCP role or a lower one, never a higher one. */
export function roleWithin(tokenRole: string, userRole: string): boolean {
  return isMcpRole(tokenRole) && isMcpRole(userRole) && MCP_ROLES.indexOf(tokenRole) <= MCP_ROLES.indexOf(userRole);
}

export const PAT_FAMILY_PREFIX = "mcp-pat:";
export const PAT_MAX_DAYS = 90;

export interface IssuedPat {
  token: string;
  tokenId: string;
  family: string;
  jti: string;
  expiresAt: string;
}

/** Sign a personal access token. The caller audits it and records its family row before returning it. */
export function issuePat(
  secret: string,
  input: { subject: string; role: McpRole; cv: string; resource: string; days: number },
): IssuedPat {
  const tokenId = randomUUID();
  const jti = randomUUID();
  const family = `${PAT_FAMILY_PREFIX}${tokenId}`;
  const ttl = input.days * 86_400;
  const token = signMcpToken(secret, "pat", { sub: input.subject, role: input.role, cv: input.cv, aud: input.resource, jti, fam: family }, ttl);
  return { token, tokenId, family, jti, expiresAt: new Date((nowSeconds() + ttl) * 1000).toISOString() };
}

/** The family store could not be read: the request is refused as unavailable, never accepted. */
export class McpStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`MCP token store unavailable: ${String((cause as Error)?.message ?? cause)}`);
  }
}

export interface McpVerifyDeps {
  secret: string;
  /** The MCP resource identifier (`<public origin>/mcp`), the only accepted audience. */
  resource: string;
  families: Pick<AuthFamilyStore, "currentJti">;
  now?: () => Date;
}

const refuse = (why: string): never => {
  throw new OAuthError(OAuthErrorCode.InvalidToken, why);
};

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * Verify a bearer token presented on `/mcp`. Accepts only the kinds that are access tokens (a PAT, and the
 * OAuth access token PR B adds); a code, a refresh token or any other kind is refused before its claims are
 * read. Returns the `AuthInfo` the SDK hands to the tools: `extra.sub`/`extra.role` are the audit actor and
 * the role the per-tool gate checks.
 */
export async function verifyMcpAccessToken(token: string, deps: McpVerifyDeps): Promise<AuthInfo> {
  const claims = readMcpToken(deps.secret, "pat", token);
  if (!claims) return refuse("invalid token");
  const sub = str(claims.sub);
  const role = str(claims.role);
  const cv = str(claims.cv);
  const jti = str(claims.jti);
  const fam = str(claims.fam);
  if (!sub || !role || !cv || !jti || !fam || !fam.startsWith(PAT_FAMILY_PREFIX)) return refuse("invalid token");
  if (claims.aud !== deps.resource) return refuse("token issued for another resource");

  // `findDemoUser` applies the profile rule, so a demo account from another deployment is refused here.
  const user = findDemoUser(sub);
  if (!user || credentialVersion(user) !== cv || !roleWithin(role, user.role)) return refuse("token no longer valid for this account");

  let current: string | null;
  try {
    current = await deps.families.currentJti(fam, (deps.now?.() ?? new Date()).toISOString());
  } catch (err) {
    throw new McpStoreUnavailableError(err);
  }
  if (current !== jti) return refuse("token revoked or expired");

  const tokenId = fam.slice(PAT_FAMILY_PREFIX.length);
  return {
    token,
    clientId: `pat:${tokenId}`,
    scopes: ["mcp"],
    expiresAt: claims.exp as number,
    resource: new URL(deps.resource),
    extra: { sub: user.email, role, credential: `pat:${tokenId}` },
  };
}
