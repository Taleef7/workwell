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
import { createJwt, type JwtService } from "../auth/jwt.ts";
import { authenticate, findDemoUser } from "../auth/demo-users.ts";

const REFRESH_COOKIE = "refresh_token";
const COOKIE_PATH = "/api/auth";

export interface AuthConfig {
  secret: string;
  cookieSameSite?: string;
  cookieSecure?: boolean;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
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
      return json(
        { token: jwt.issueAccessToken(user.email, user.role), email: user.email, role: user.role },
        200,
        { "set-cookie": refreshCookie(jwt.issueRefreshToken(user.email), jwt.refreshTtlSeconds) },
      );
    }

    if (pathname === "/api/auth/refresh") {
      const cookie = readCookie(req, REFRESH_COOKIE);
      const email = cookie ? jwt.verifyRefreshToken(cookie) : null;
      const user = email ? findDemoUser(email) : null;
      if (!user) return json({ error: "invalid_refresh_token" }, 401);
      return json(
        { token: jwt.issueAccessToken(user.email, user.role), email: user.email, role: user.role },
        200,
        { "set-cookie": refreshCookie(jwt.issueRefreshToken(user.email), jwt.refreshTtlSeconds) },
      );
    }

    if (pathname === "/api/auth/logout") {
      return new Response(null, { status: 204, headers: { "set-cookie": refreshCookie("", 0) } });
    }

    return null;
  };
}
