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
  throw new OAuthError(OAuthErrorCode.InvalidToken, `${why}; sign in again from your MCP client, or mint a new MCP token in Admin → MCP access`);
};

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export const OAUTH_FAMILY_PREFIX = "oauth:";
export const OAUTH_ACCESS_TTL_SECONDS = 900;
export const OAUTH_REFRESH_TTL_SECONDS = 30 * 86_400;
export const OAUTH_GRANT_MAX_SECONDS = 90 * 86_400;
/**
 * A grant's row value from consent until its one-time code is redeemed (`routes/oauth.ts`): it names the code,
 * so the code IS this row's state, and redeeming it is one atomic update to the live value. Not yet a connected
 * client.
 */
const OAUTH_PENDING_PREFIX = "pending:";
export const oauthPendingGrant = (codeJti: string): string => `${OAUTH_PENDING_PREFIX}${codeJti}~~0`;
export const isOauthPendingGrant = (value: string): boolean => value.startsWith(OAUTH_PENDING_PREFIX);

/**
 * The account a token speaks for, if it still may: the account exists on this profile (`findDemoUser`
 * applies the profile rule), its credential version is the one the token was minted under (a password
 * change ends every token), and the token's role is an MCP role no higher than the account's.
 */
export function accountFor(sub: unknown, cv: unknown, role: unknown): { email: string; role: McpRole } | null {
  if (typeof sub !== "string" || typeof cv !== "string" || typeof role !== "string") return null;
  const user = findDemoUser(sub);
  if (!user || credentialVersion(user) !== cv || !roleWithin(role, user.role)) return null;
  return { email: user.email, role: role as McpRole };
}

/**
 * Verify a bearer token presented on `/mcp`. Only the two kinds that are access tokens are accepted: a
 * personal access token (its row must hold its own jti) and an OAuth access token (its grant's row must
 * exist, so revoking the grant ends it at once). A code, a refresh token or any other kind fails both keys
 * before its claims are read. Returns the `AuthInfo` the SDK hands to the tools: `extra.sub`/`extra.role`
 * are the audit actor and the role the per-tool gate checks.
 */
export async function verifyMcpAccessToken(token: string, deps: McpVerifyDeps): Promise<AuthInfo> {
  const pat = readMcpToken(deps.secret, "pat", token);
  const claims = pat ?? readMcpToken(deps.secret, "oauth-access", token);
  if (!claims) return refuse("invalid token");
  const fam = str(claims.fam);
  const jti = str(claims.jti);
  const clientId = str(claims.client_id);
  if (!fam || !fam.startsWith(pat ? PAT_FAMILY_PREFIX : OAUTH_FAMILY_PREFIX)) return refuse("invalid token");
  if (pat ? !jti : !clientId) return refuse("invalid token");
  if (claims.aud !== deps.resource) return refuse("token issued for another resource");

  const account = accountFor(claims.sub, claims.cv, claims.role);
  if (!account) return refuse("token no longer valid for this account");

  let current: string | null;
  try {
    current = await deps.families.currentJti(fam, (deps.now?.() ?? new Date()).toISOString());
  } catch (err) {
    throw new McpStoreUnavailableError(err);
  }
  if (pat ? current !== jti : current === null) return refuse("token revoked or expired");

  const credential = pat ? `pat:${fam.slice(PAT_FAMILY_PREFIX.length)}` : fam;
  return {
    token,
    clientId: pat ? credential : clientId!,
    scopes: ["mcp"],
    expiresAt: claims.exp as number,
    // The token's own audience (equal to `deps.resource`, checked above), so the SDK's `expectedResource`
    // comparison checks the token rather than echoing the configuration back to itself.
    resource: new URL(claims.aud as string),
    extra: { sub: account.email, role: account.role, credential },
  };
}
