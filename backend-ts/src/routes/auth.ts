/**
 * Auth route (#105) — TS port of com.workwell.web.AuthController. JVM-free.
 *
 *   POST /api/auth/login    { email, password } → { token, email, role } + Set-Cookie refresh_token
 *   POST /api/auth/refresh  reads refresh_token cookie → new access token + rotated cookie
 *   POST /api/auth/logout   clears the refresh_token cookie
 *
 * Preserves the wire contract the unchanged frontend depends on: the access token in
 * the JSON body, and an HttpOnly refresh cookie scoped to /api/auth. SameSite=None
 * forces Secure (browsers drop a cross-site cookie otherwise), matching the Java side.
 */
import { randomUUID } from "node:crypto";
import { createJwt, type JwtService } from "../auth/jwt.ts";
import { authenticate, findDemoUser } from "../auth/demo-users.ts";

const REFRESH_COOKIE = "refresh_token";
const COOKIE_PATH = "/api/auth";

/**
 * Server-side refresh-token revocation (Fable M5). A refresh token carries a stable per-login
 * `fam`(ily) id and a per-rotation `jti`; the store tracks the family's CURRENT jti. This gives
 * two properties a stateless HS256 refresh token cannot:
 *   - logout invalidates the token (the family is revoked, so the still-unexpired JWT is dead);
 *   - rotation invalidates the previous token, and presenting a stale/rotated jti (token REUSE)
 *     revokes the whole family (classic refresh-token-reuse detection).
 * It is optional: when absent (unit tests) or when a store op THROWS (KV outage), the flow falls
 * back to the prior stateless behavior — a store error must never hard-log-out a live user. A
 * definitive null/mismatch from a working store IS fail-closed (that's the whole point). Legacy
 * tokens minted before this change carry no `fam` and are accepted once, then upgraded on rotation.
 */
export interface RefreshTokenRevocation {
  /** The family's current valid jti, or null if the family is unknown / revoked / expired. */
  currentJti(family: string): Promise<string | null>;
  /** Record `jti` as the family's current token (expires with the refresh TTL). */
  rotate(family: string, jti: string, ttlSeconds: number): Promise<void>;
  /** Revoke the whole family (logout, or reuse detection). */
  revoke(family: string): Promise<void>;
}

export interface AuthConfig {
  secret: string;
  cookieSameSite?: string;
  cookieSecure?: boolean;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  /** Optional refresh-token revocation store (M5). Absent ⇒ stateless (prior behavior). */
  revocation?: RefreshTokenRevocation;
}

function normalizeSameSite(raw: string | undefined): "Lax" | "Strict" | "None" {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "none":
      return "None";
    case "strict":
      return "Strict";
    default:
      return "Lax";
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface AuthHandler {
  (req: Request): Promise<Response | null>;
}

export function createAuthHandler(config: AuthConfig): AuthHandler {
  const sameSite = normalizeSameSite(config.cookieSameSite);
  // SameSite=None is silently dropped unless Secure, so force it (matches Java).
  const secure = (config.cookieSecure ?? false) || sameSite === "None";
  const jwt: JwtService = createJwt({
    secret: config.secret,
    accessTtlSeconds: config.accessTtlSeconds,
    refreshTtlSeconds: config.refreshTtlSeconds,
  });
  const revocation = config.revocation;

  // Issue a rotated refresh token: mint a fresh jti in the given family and record it as current.
  // If the rotation WRITE fails (KV outage), issue an UNTRACKED, legacy-shaped token (no jti/fam)
  // instead of a tracked one (Codex P2): a tracked token whose jti was never recorded would be
  // fail-closed on the next refresh — `currentJti` returns null (login-write failure) or a stale jti
  // (refresh-write failure), so the fresh cookie would be rejected or (worse) trip reuse detection and
  // revoke the family — the opposite of the intended stateless degradation. An untracked token skips
  // the revocation check entirely (the JWT alone still gates on signature + exp) and is upgraded into a
  // family on the next successful rotation.
  const issueRotatedRefresh = async (email: string, family: string): Promise<string> => {
    if (!revocation) return jwt.issueRefreshToken(email, { jti: randomUUID(), fam: family });
    const jti = randomUUID();
    try {
      await revocation.rotate(family, jti, jwt.refreshTtlSeconds);
    } catch {
      return jwt.issueRefreshToken(email); // untracked legacy-shaped token → stateless degrade
    }
    return jwt.issueRefreshToken(email, { jti, fam: family });
  };

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

  const refreshCookie = (value: string, maxAgeSeconds: number): string => {
    const attrs = [`${REFRESH_COOKIE}=${value}`, `Max-Age=${maxAgeSeconds}`, `Path=${COOKIE_PATH}`, "HttpOnly", `SameSite=${sameSite}`];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
  };

  return async function handleAuth(req: Request): Promise<Response | null> {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/api/auth/") || req.method !== "POST") return null;

    if (pathname === "/api/auth/login") {
      const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
      const email = typeof body?.email === "string" ? body.email : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!email || !password) return json({ error: "invalid_credentials" }, 401);
      const user = await authenticate(email, password);
      if (!user) return json({ error: "invalid_credentials" }, 401);
      // A fresh login opens a new token family.
      const refresh = await issueRotatedRefresh(user.email, randomUUID());
      return json(
        { token: jwt.issueAccessToken(user.email, user.role), email: user.email, role: user.role },
        200,
        { "set-cookie": refreshCookie(refresh, jwt.refreshTtlSeconds) },
      );
    }

    if (pathname === "/api/auth/refresh") {
      const cookie = readCookie(req, REFRESH_COOKIE);
      const claims = cookie ? jwt.readRefreshToken(cookie) : null;
      const user = claims ? findDemoUser(claims.email) : null;
      if (!claims || !user) return json({ error: "invalid_refresh_token" }, 401);

      // Rotation / reuse check (M5). Only enforced when we have a working store AND the token
      // carries a family (legacy tokens have none — accept once, then upgrade into a family).
      if (revocation && claims.fam && claims.jti) {
        let current: string | null | undefined;
        try {
          current = await revocation.currentJti(claims.fam);
        } catch {
          current = undefined; // store unavailable → fall through (fail-open on outage)
        }
        if (current !== undefined) {
          if (current === null) {
            // Family revoked (logout) or expired — the token is dead even if the JWT hasn't expired.
            return json({ error: "invalid_refresh_token" }, 401);
          }
          if (current !== claims.jti) {
            // A rotated-away jti was replayed → token reuse. Revoke the whole family.
            try {
              await revocation.revoke(claims.fam);
            } catch {
              /* best-effort */
            }
            return json({ error: "invalid_refresh_token" }, 401);
          }
        }
      }

      const family = claims.fam ?? randomUUID(); // upgrade a legacy (family-less) token into a family
      const refresh = await issueRotatedRefresh(user.email, family);
      return json(
        { token: jwt.issueAccessToken(user.email, user.role), email: user.email, role: user.role },
        200,
        { "set-cookie": refreshCookie(refresh, jwt.refreshTtlSeconds) },
      );
    }

    if (pathname === "/api/auth/logout") {
      // Revoke the family so the (still-unexpired) refresh JWT can't be reused after logout (M5).
      if (revocation) {
        const cookie = readCookie(req, REFRESH_COOKIE);
        const claims = cookie ? jwt.readRefreshToken(cookie) : null;
        if (claims?.fam) {
          try {
            await revocation.revoke(claims.fam);
          } catch {
            /* best-effort — the cookie is cleared regardless */
          }
        }
      }
      return new Response(null, { status: 204, headers: { "set-cookie": refreshCookie("", 0) } });
    }

    return null;
  };
}
