/**
 * WorkWell TS backend — worker entry (Phase 0 skeleton, issue #96 / ADR-008).
 *
 * The SAME module runs unchanged on every target (Cloudflare native, the
 * @mieweb/cloud-local Node host, and mieweb/os adapters) — see wrangler.jsonc
 * for the binding shapes and mieweb.jsonc for the per-target drivers.
 *
 * This is a skeleton: only health/version are wired. The real endpoint groups
 * are ported strangler-fig in Phase 4 (#107, #108), each behind the unchanged
 * frontend fetch contract (frontend/lib/api/client.ts). Persistence goes
 * through the storage contracts in src/stores (#104); compliance goes through
 * the EvaluateMeasure compute binding in src/engine (#106).
 */
import type {
  CloudDatabase,
  CloudBucket,
  CloudKV,
  CloudQueue,
  CloudExecutionContext,
} from "@mieweb/cloud";
import { handleRuns } from "./routes/runs.ts";
import { handleMeasures } from "./routes/measures.ts";
import { handleCases } from "./routes/cases.ts";
import { createAuthHandler, type AuthHandler } from "./routes/auth.ts";
import { createJwt, type JwtService } from "./auth/jwt.ts";
import { authorize, extractPrincipal } from "./auth/authorize.ts";
import { assertSafeStartup, type StartupEnv } from "./config/startup-safety.ts";
import { parseAllowedOrigins, preflightResponse, withCors } from "./config/cors.ts";

/** Runtime bindings (wrangler.jsonc) + config. Injected per target; app code
 *  only ever sees these Cloudflare-shaped contracts, never a concrete driver. */
export interface Env {
  /** D1 (sqlite floor / libSQL / Postgres ceiling) — app system of record. */
  DB: CloudDatabase;
  /** R2 (fs / S3-MinIO) — evidence file uploads/downloads. */
  BUCKET: CloudBucket;
  /** KV (memory / Valkey) — measure-catalog warm cache. */
  CACHE: CloudKV;
  /** Queue (in-proc / Valkey list / PG SKIP LOCKED) — async run-job pipeline. */
  JOBS: CloudQueue;

  // ---- plain runtime config (not @mieweb/cloud bindings) ------------------
  WORKWELL_AUTH_JWT_SECRET?: string;
  WORKWELL_AUTH_ENABLED?: string;
  WORKWELL_AUTH_COOKIE_SAME_SITE?: string;
  WORKWELL_AUTH_COOKIE_SECURE?: string;
  WORKWELL_ENVIRONMENT?: string;
  SPRING_PROFILES_ACTIVE?: string;
  NODE_ENV?: string;
  WORKWELL_CORS_ALLOWED_ORIGINS?: string;
  OPENAI_API_KEY?: string;
}

// Memoized auth handler + JWT verifier, keyed by secret (createJwt is per-call).
let cachedSecret: string | undefined;
let authHandler: AuthHandler | undefined;
let verifier: JwtService | undefined;
function getAuthHandler(env: Env): AuthHandler | null {
  if (!env.WORKWELL_AUTH_JWT_SECRET) return null; // not configured — see fail-fast below
  rebuildAuthIfNeeded(env);
  return authHandler ?? null;
}
function getVerifier(env: Env): JwtService | null {
  if (!env.WORKWELL_AUTH_JWT_SECRET) return null;
  rebuildAuthIfNeeded(env);
  return verifier ?? null;
}
function rebuildAuthIfNeeded(env: Env): void {
  if (authHandler && cachedSecret === env.WORKWELL_AUTH_JWT_SECRET) return;
  cachedSecret = env.WORKWELL_AUTH_JWT_SECRET;
  authHandler = createAuthHandler({
    secret: env.WORKWELL_AUTH_JWT_SECRET!,
    cookieSameSite: env.WORKWELL_AUTH_COOKIE_SAME_SITE,
    cookieSecure: env.WORKWELL_AUTH_COOKIE_SECURE === "true",
  });
  verifier = createJwt({ secret: env.WORKWELL_AUTH_JWT_SECRET! });
}

// Fail-fast: validate auth/cookie config once. If unsafe, every request 503s with
// the reason (the Worker analogue of a crash-on-boot ApplicationRunner).
let startupError: string | null | undefined;
function startupGuard(env: Env): string | null {
  if (startupError !== undefined) return startupError;
  try {
    assertSafeStartup(env as StartupEnv);
    startupError = null;
  } catch (err) {
    startupError = String((err as Error)?.message ?? err);
  }
  return startupError;
}

function authEnabled(env: Env): boolean {
  return !!env.WORKWELL_AUTH_JWT_SECRET && (env.WORKWELL_AUTH_ENABLED ?? "true").toLowerCase() !== "false";
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Route a request to a Response (no CORS decoration — the caller adds that). */
async function route(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);

  // Fail-fast: refuse to serve under an unsafe auth/cookie/CORS configuration.
  const unsafe = startupGuard(env);
  if (unsafe) return json({ error: "unsafe_configuration", message: unsafe }, 503);

  // Health — parity with the Java backend's GET /actuator/health.
  if (pathname === "/actuator/health" || pathname === "/health") {
    return json({ status: "UP", stack: "workwell-ts", phase: "1-spike" });
  }

  // Version — parity with GET /api/version (unauthenticated discovery).
  if (pathname === "/api/version") {
    return json({ api: "v1", stack: "typescript", build: "phase1-spike" });
  }

  // Authorization gate — port of JwtAuthFilter + SecurityConfig (#105). Skipped
  // entirely when auth is disabled (no secret), mirroring authEnabled=false → permitAll.
  // The authenticated subject becomes the audit actor (SecurityActor.currentActor()).
  let actor = "system";
  if (authEnabled(env)) {
    const principal = extractPrincipal(req, getVerifier(env)!);
    const decision = authorize(req.method, pathname, principal);
    if (!decision.ok) {
      return json({ error: decision.status === 403 ? "forbidden" : "unauthenticated" }, decision.status!);
    }
    if (principal?.email) actor = principal.email;
  }

  // Auth — login/refresh/logout, JVM-free JWT + PBKDF2 (#105).
  const auth = getAuthHandler(env);
  if (auth) {
    const authResponse = await auth(req);
    if (authResponse) return authResponse;
  } else if (pathname.startsWith("/api/auth/")) {
    return json({ error: "auth_not_configured", hint: "WORKWELL_AUTH_JWT_SECRET is unset" }, 503);
  }

  // Measures — live CQL/eCQM evaluation in Node (no JVM), #106.
  const measuresResponse = await handleMeasures(req);
  if (measuresResponse) return measuresResponse;

  // Runs — live through RunStore → CloudDatabase (SQLite floor). Spike, #103.
  const runsResponse = await handleRuns(req, env);
  if (runsResponse) return runsResponse;

  // Cases — worklist + detail + actions over the cases upserted from run outcomes (#107).
  const casesResponse = await handleCases(req, env, actor);
  if (casesResponse) return casesResponse;

  // Everything else is not ported yet. Be honest (no faked behavior), the
  // same principle as UnsupportedBindingError / "AI never decides compliance".
  return json(
    {
      error: "not_implemented",
      path: pathname,
      hint: "TS backend skeleton — endpoint groups are ported in Phase 4 (#107/#108)",
    },
    501,
  );
}

export default {
  async fetch(req: Request, env: Env, _ctx: CloudExecutionContext): Promise<Response> {
    const origins = parseAllowedOrigins(env.WORKWELL_CORS_ALLOWED_ORIGINS);
    // CORS preflight must be answered before auth — browsers send OPTIONS without
    // credentials, so the real cross-site login/API call is blocked otherwise.
    if (req.method === "OPTIONS") return preflightResponse(req, origins);
    return withCors(await route(req, env), req, origins);
  },
};
