/**
 * Production fail-fast invariants (#105) — TS port of the auth/cookie subset of
 * com.workwell.config.StartupSafetyValidator. Throws on an unsafe configuration so a
 * misconfigured production deploy crashes loudly instead of silently shipping an
 * auth-disabled / weak-secret / wrong-cookie backend.
 *
 * (CORS-origin and demo-flag checks stay with the Java validator until the CORS layer
 * is ported in Phase 4; the auth + cookie invariants are the ones #105 owns.)
 */
const PRODUCTION_LIKE_PROFILES = new Set(["prod", "production", "fly", "staging"]);
const KNOWN_WEAK_JWT_SECRETS = new Set([
  "change-me",
  "dev-secret",
  "secret",
  "workwell123",
  "workwell123!",
  "workwell-demo-secret-change-me",
]);

export interface StartupEnv {
  WORKWELL_ENVIRONMENT?: string;
  SPRING_PROFILES_ACTIVE?: string;
  NODE_ENV?: string;
  WORKWELL_AUTH_ENABLED?: string;
  WORKWELL_AUTH_JWT_SECRET?: string;
  WORKWELL_AUTH_COOKIE_SAME_SITE?: string;
  WORKWELL_AUTH_COOKIE_SECURE?: string;
}

export function isProductionLike(env: StartupEnv): boolean {
  const profiles = (env.SPRING_PROFILES_ACTIVE ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (profiles.some((p) => PRODUCTION_LIKE_PROFILES.has(p))) return true;
  const explicit = (env.WORKWELL_ENVIRONMENT ?? "").trim().toLowerCase();
  if (explicit === "production" || explicit === "prod") return true;
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

export function isWeakJwtSecret(secret: string | undefined): boolean {
  if (!secret || !secret.trim()) return true;
  const normalized = secret.trim();
  if (normalized.length < 32) return true;
  return KNOWN_WEAK_JWT_SECRETS.has(normalized.toLowerCase());
}

/** Throws IllegalState-style errors on unsafe config. Call once at startup. */
export function assertSafeStartup(env: StartupEnv): void {
  const productionLike = isProductionLike(env);
  const authEnabled = (env.WORKWELL_AUTH_ENABLED ?? "true").trim().toLowerCase() !== "false";

  if (productionLike) {
    if (!authEnabled) {
      throw new Error("Unsafe WorkWell configuration: WORKWELL_AUTH_ENABLED=false is not allowed in production.");
    }
    if (isWeakJwtSecret(env.WORKWELL_AUTH_JWT_SECRET)) {
      throw new Error(
        "Unsafe WorkWell configuration: WORKWELL_AUTH_JWT_SECRET must be at least 32 characters and not a demo/default value in production.",
      );
    }
  }

  // Default SameSite=Lax / Secure=false match the Java @Value defaults (local same-origin dev).
  assertSafeCookiePolicy(
    productionLike,
    env.WORKWELL_AUTH_COOKIE_SAME_SITE ?? "Lax",
    (env.WORKWELL_AUTH_COOKIE_SECURE ?? "false").trim().toLowerCase() === "true",
  );
}

export function assertSafeCookiePolicy(productionLike: boolean, cookieSameSite: string | undefined, cookieSecure: boolean): void {
  const normalized = (cookieSameSite ?? "").trim();
  const known = ["none", "lax", "strict"].includes(normalized.toLowerCase());
  if (!known) {
    throw new Error(
      `Unsafe WorkWell configuration: WORKWELL_AUTH_COOKIE_SAME_SITE must be one of None, Lax, or Strict (got '${normalized}'). An unknown value emits a malformed Set-Cookie SameSite attribute and breaks auth.`,
    );
  }
  const sameSiteNone = normalized.toLowerCase() === "none";
  if (sameSiteNone && !cookieSecure) {
    throw new Error(
      "Unsafe WorkWell configuration: WORKWELL_AUTH_COOKIE_SAME_SITE=None requires WORKWELL_AUTH_COOKIE_SECURE=true (browsers drop non-Secure SameSite=None cookies).",
    );
  }
  if (!productionLike) return;
  if (!sameSiteNone) {
    throw new Error(
      `Unsafe WorkWell configuration: production uses a cross-site frontend/backend split, so WORKWELL_AUTH_COOKIE_SAME_SITE must be 'None' (got '${normalized}'). A Lax/Strict refresh cookie is never sent on the cross-site refresh request and silently breaks session persistence.`,
    );
  }
  if (!cookieSecure) {
    throw new Error("Unsafe WorkWell configuration: WORKWELL_AUTH_COOKIE_SECURE must be true in production.");
  }
}
