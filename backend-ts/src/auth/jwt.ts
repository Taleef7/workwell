/**
 * JVM-free JWT service (#105) — TS port of com.workwell.security.JwtService.
 *
 * Preserves the exact wire contract so the unchanged frontend and any Java-issued
 * token interoperate during the strangler cutover:
 *   - HS256, header `{"alg":"HS256","typ":"JWT"}`, all segments base64url, no padding
 *   - access token payload  `{ sub: email, role, iat, exp }`  (default TTL 900s)
 *   - refresh token payload `{ sub: email, refresh: true, iat, exp }` (default 28800s)
 *   - a refresh token must NEVER authenticate a normal API request, and an access
 *     token is never accepted where a refresh token is required.
 * Uses only Node's built-in `crypto` (no new dependency). Signature verification is
 * constant-time. All verify paths return null/empty on any failure (never throw).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtConfig {
  secret: string;
  /** Access-token lifetime in seconds (default 900 = 15m, matching Java). */
  accessTtlSeconds?: number;
  /** Refresh-token lifetime in seconds (default 28800 = 8h, matching Java). */
  refreshTtlSeconds?: number;
}

export interface JwtPrincipal {
  email: string;
  role: string;
}

/** The revocation-relevant claims carried by a rotated refresh token (Fable M5). */
export interface RefreshClaims {
  email: string;
  /** Per-token id (rotated on every refresh) — the current jti is tracked server-side. */
  jti?: string;
  /** Per-login-session family id (stable across rotations) — the revocation key. */
  fam?: string;
}

export interface JwtService {
  issueAccessToken(email: string, role: string): string;
  /** Issue a refresh token; optional `jti`/`fam` claims support server-side rotation tracking (M5). */
  issueRefreshToken(email: string, extra?: { jti?: string; fam?: string }): string;
  /** Returns the principal for a valid, non-expired, non-refresh access token, else null. */
  verifyAccessToken(token: string): JwtPrincipal | null;
  /** Returns the subject email for a valid, non-expired refresh token, else null. */
  verifyRefreshToken(token: string): string | null;
  /** Like verifyRefreshToken but also returns the rotation claims (jti/fam) when present. */
  readRefreshToken(token: string): RefreshClaims | null;
  readonly refreshTtlSeconds: number;
}

const b64url = (data: Buffer | string): string =>
  Buffer.from(data as never).toString("base64url");

const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function createJwt(config: JwtConfig): JwtService {
  const secret = config.secret;
  const accessTtl = config.accessTtlSeconds ?? 900;
  const refreshTtl = config.refreshTtlSeconds ?? 28800;

  const sign = (headerAndPayload: string): string =>
    createHmac("sha256", secret).update(headerAndPayload).digest("base64url");

  const issue = (claims: Record<string, unknown>, ttl: number): string => {
    const now = nowSeconds();
    const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttl }));
    const body = `${HEADER}.${payload}`;
    return `${body}.${sign(body)}`;
  };

  /** Verify signature + structure, returning the decoded payload or null. */
  const verify = (token: string): Record<string, unknown> | null => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    const expected = sign(`${header}.${payload}`);
    // constant-time compare; length mismatch is an immediate reject
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const exp = claims.exp;
    if (typeof exp !== "number" || nowSeconds() >= exp) return null;
    return claims;
  };

  return {
    refreshTtlSeconds: refreshTtl,

    issueAccessToken(email, role) {
      return issue({ sub: email, role }, accessTtl);
    },

    issueRefreshToken(email, extra) {
      const claims: Record<string, unknown> = { sub: email, refresh: true };
      if (extra?.jti) claims.jti = extra.jti;
      if (extra?.fam) claims.fam = extra.fam;
      return issue(claims, refreshTtl);
    },

    verifyAccessToken(token) {
      const claims = verify(token);
      if (!claims || claims.refresh === true) return null; // refresh token can't authenticate
      const email = typeof claims.sub === "string" ? claims.sub : "";
      const role = typeof claims.role === "string" ? claims.role : "";
      if (!email || !role) return null;
      return { email, role };
    },

    verifyRefreshToken(token) {
      const claims = verify(token);
      if (!claims || claims.refresh !== true) return null;
      const email = typeof claims.sub === "string" ? claims.sub : "";
      return email || null;
    },

    readRefreshToken(token) {
      const claims = verify(token);
      if (!claims || claims.refresh !== true) return null;
      const email = typeof claims.sub === "string" ? claims.sub : "";
      if (!email) return null;
      return {
        email,
        jti: typeof claims.jti === "string" ? claims.jti : undefined,
        fam: typeof claims.fam === "string" ? claims.fam : undefined,
      };
    },
  };
}
