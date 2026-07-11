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
import { handleCampaigns } from "./routes/campaigns.ts";
import { handleEmployees } from "./routes/employees.ts";
import { handlePrograms } from "./routes/programs.ts";
import { handleHierarchy } from "./routes/hierarchy.ts";
import { handleTenants } from "./routes/tenants.ts";
import { handleQuality } from "./routes/quality.ts";
import { handleIdentity } from "./routes/identity.ts";
import { handleCompliance } from "./routes/compliance.ts";
import { handleSegments } from "./routes/segments.ts";
import { handleOutcomes } from "./routes/outcomes.ts";
import { handleImmunizationForecast } from "./routes/immunization.ts";
import { handleComplianceSimulation } from "./routes/compliance-simulation.ts";
import { handleOrders } from "./routes/orders.ts";
import { handleExports } from "./routes/exports.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleAi } from "./routes/ai.ts";
import { handleMcp } from "./routes/mcp.ts";
import { handleAuditor } from "./routes/auditor.ts";
import { createAuthHandler, type AuthHandler, type RefreshTokenRevocation } from "./routes/auth.ts";
import { createJwt, type JwtService } from "./auth/jwt.ts";
import { authorize, extractPrincipal } from "./auth/authorize.ts";
import { assertSafeStartup, type StartupEnv } from "./config/startup-safety.ts";
import { parseAllowedOrigins, preflightResponse, withCors } from "./config/cors.ts";
import { formatSeamLogLine } from "./config/seam-inventory.ts";

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
  /**
   * Postgres connection string (the ceiling). When set, the store factory uses the Pg* adapters
   * instead of the `DB` SQLite floor (#109 cutover, Neon/Postgres path) — see stores/factory.ts.
   */
  DATABASE_URL?: string;
  WORKWELL_AUTH_JWT_SECRET?: string;
  WORKWELL_AUTH_ENABLED?: string;
  WORKWELL_AUTH_COOKIE_SAME_SITE?: string;
  WORKWELL_AUTH_COOKIE_SECURE?: string;
  WORKWELL_ENVIRONMENT?: string;
  SPRING_PROFILES_ACTIVE?: string;
  NODE_ENV?: string;
  WORKWELL_CORS_ALLOWED_ORIGINS?: string;
  OPENAI_API_KEY?: string;
  WORKWELL_AI_OPENAI_MODEL?: string;
  WORKWELL_AI_OPENAI_FALLBACK_MODEL?: string;
  /** Immunization forecasting (#76 E6) — ICE API config. Inert stub unless both are set. */
  WORKWELL_IMMZ_ICE_API_KEY?: string;
  WORKWELL_IMMZ_ICE_BASE_URL?: string;
  /** Order generation EH FHIR seam (#77 E7) — standing-order dedupe. Inert stub unless both are set. */
  WORKWELL_EH_FHIR_BASE_URL?: string;
  WORKWELL_EH_FHIR_API_KEY?: string;
  /** Outreach email provider (Sprint 6). Simulated by default; SendGrid stub only if provider=sendgrid AND a key are set. */
  WORKWELL_EMAIL_PROVIDER?: string;
  WORKWELL_EMAIL_SENDGRID_API_KEY?: string;
  /** DataChaser outreach seam (#75 E5). Inert stub unless both are set. */
  WORKWELL_OUTREACH_DATACHASER_API_KEY?: string;
  WORKWELL_OUTREACH_DATACHASER_BASE_URL?: string;
  /** WebChart data-ingress seam (#184 E12). Inert stub unless both are set. */
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;
  /** Measure-executor seam (#78 E9; ADR-025). FHIR-native default; "sql-pushdown" is an inert opt-in stub. */
  WORKWELL_MEASURE_EXECUTOR?: string;
  /** VSAC value-set resolution (ADR-023). Inert (local-store-only) unless the key is set. */
  WORKWELL_VSAC_API_KEY?: string;
  WORKWELL_VSAC_BASE_URL?: string;
  /** Failed-run alert webhook (#264). Inert unless set — console WORKWELL_ALERT line always fires. */
  WORKWELL_ALERT_WEBHOOK_URL?: string;
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
    revocation: kvRefreshRevocation(env.CACHE), // server-side refresh rotation/logout revocation (M5)
  });
  verifier = createJwt({ secret: env.WORKWELL_AUTH_JWT_SECRET! });
}

/**
 * Refresh-token revocation backed by the KV binding (Fable M5). Keyed by token family; the value is
 * the family's current jti. A missing binding (or any op that throws) degrades to stateless auth —
 * the auth handler treats a throw as "store unavailable" and never hard-logs-out on it.
 */
function kvRefreshRevocation(cache: Env["CACHE"] | undefined): RefreshTokenRevocation | undefined {
  if (!cache) return undefined;
  const key = (family: string): string => `refresh_fam:${family}`;
  return {
    async currentJti(family) {
      return (await cache.get(key(family))) ?? null;
    },
    async rotate(family, jti, ttlSeconds) {
      // Cloudflare KV requires expirationTtl >= 60s; the refresh TTL (28800) is well above.
      await cache.put(key(family), jti, { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) });
    },
    async revoke(family) {
      await cache.delete(key(family));
    },
  };
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
async function route(req: Request, env: Env, ctx: CloudExecutionContext): Promise<Response> {
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
  let principalRole: string | null = null;
  const enforceAuth = authEnabled(env);
  if (enforceAuth) {
    const principal = extractPrincipal(req, getVerifier(env)!);
    const decision = authorize(req.method, pathname, principal);
    if (!decision.ok) {
      return json({ error: decision.status === 403 ? "forbidden" : "unauthenticated" }, decision.status!);
    }
    if (principal?.email) actor = principal.email;
    principalRole = principal?.role ?? null;
  }

  // Auth — login/refresh/logout, JVM-free JWT + PBKDF2 (#105).
  const auth = getAuthHandler(env);
  if (auth) {
    const authResponse = await auth(req);
    if (authResponse) return authResponse;
  } else if (pathname.startsWith("/api/auth/")) {
    return json({ error: "auth_not_configured", hint: "WORKWELL_AUTH_JWT_SECRET is unset" }, 503);
  }

  // Measures — catalog + authoring (persisted store) + live CQL/eCQM evaluation (no JVM), #106/#107.
  const measuresResponse = await handleMeasures(req, env, actor);
  if (measuresResponse) return measuresResponse;

  // Runs — live through RunStore → CloudDatabase (SQLite floor). Spike, #103. ALL_PROGRAMS/SITE
  // finish in the background via ctx.waitUntil (long fan-out); the page polls to terminal.
  const runsResponse = await handleRuns(req, env, actor, (p) => ctx.waitUntil(p));
  if (runsResponse) return runsResponse;

  // Cases — worklist + detail + actions over the cases upserted from run outcomes (#107).
  const casesResponse = await handleCases(req, env, actor);
  if (casesResponse) return casesResponse;

  // Campaigns — batch outreach over eligible OPEN cases (run/list/detail) (#75 E5).
  const campaignsResponse = await handleCampaigns(req, env, actor);
  if (campaignsResponse) return campaignsResponse;

  // Employees — directory profile + search over the synthetic directory + outcomes/cases (#107).
  const employeesResponse = await handleEmployees(req, env);
  if (employeesResponse) return employeesResponse;

  // Programs — compliance KPI overview + site list over runs/outcomes/cases (#107).
  const programsResponse = await handlePrograms(req, env);
  if (programsResponse) return programsResponse;

  // Hierarchy — multi-level dashboard rollup over outcomes/cases (#74 E4; multi-tenant #185 E13).
  const hierarchyResponse = await handleHierarchy(req, env);
  if (hierarchyResponse) return hierarchyResponse;

  // Tenants — WebChart system list for the multi-tenant selector (#185 E13 PR-1).
  const tenantsResponse = await handleTenants(req);
  if (tenantsResponse) return tenantsResponse;

  // Quality-over-time history — materialized snapshot time-series read (#E16 PR-2).
  const qualityResponse = await handleQuality(req, env);
  if (qualityResponse) return qualityResponse;

  // Identity — cross-system person resolution / duplicates / mobility (#187 E15). ALL /api/identity/**
  // methods (reads AND the reconcile POST) are CASE_MANAGER/ADMIN-gated (the directory exposes
  // national/MRN ids + DOB, so it is NOT left to the AUTHENTICATED /api/** fallback); writes are audited.
  const identityResponse = await handleIdentity(req, env, actor);
  if (identityResponse) return identityResponse;

  // Segments — risk-group CRUD + membership preview (#183 E11.3). Writes ADMIN-gated, audited.
  const segmentsResponse = await handleSegments(req, env, actor);
  if (segmentsResponse) return segmentsResponse;

  // Compliance roster — individual compliance status grid by panel (#189 E10.2).
  const complianceResponse = await handleCompliance(req, env);
  if (complianceResponse) return complianceResponse;

  // Single outcome evidence — hydrates a roster cell's evidenceRef for the compliance card.
  const outcomesResponse = await handleOutcomes(req, env);
  if (outcomesResponse) return outcomesResponse;

  // Immunization forecast — advisory ICE-ready forecasting over the synthetic history (#76 E6).
  const immunizationResponse = await handleImmunizationForecast(req, env);
  if (immunizationResponse) return immunizationResponse;

  // Advisory as-of-date compliance simulation for one employee (#197) — read-only, no writes.
  const simulationResponse = await handleComplianceSimulation(req, env);
  if (simulationResponse) return simulationResponse;

  // Order proposals — advisory "Action Evaluators → orders" over latest population runs (#77 E7).
  const ordersResponse = await handleOrders(req, env);
  if (ordersResponse) return ordersResponse;

  // Exports — runs/outcomes/cases/audit CSV downloads (#108).
  const exportsResponse = await handleExports(req, env);
  if (exportsResponse) return exportsResponse;

  // Auditor packets — downloadable run / measure-version evidence bundles (#108). Role gates
  // (CASE_MANAGER/ADMIN for runs, APPROVER/ADMIN for measure versions) are in the authorize matrix.
  const auditorResponse = await handleAuditor(req, env, actor);
  if (auditorResponse) return auditorResponse;

  // Admin — dashboard read surface + simple toggles (#108). Gated to ADMIN by the matrix.
  const adminResponse = await handleAdmin(req, env, actor);
  if (adminResponse) return adminResponse;

  // AI surfaces — draft-spec/draft-cql/test-fixtures/explain/run-insight (#108). Advisory
  // text/drafts only (AI never decides compliance); deterministic fallback when no OPENAI_API_KEY.
  const aiResponse = await handleAi(req, env, actor);
  if (aiResponse) return aiResponse;

  // MCP — read-only tools over SSE + JSON-RPC (#108). Transport gate ([ADMIN/CASE_MANAGER/
  // MCP_CLIENT] on /sse + /mcp/**) is applied above; per-tool role gates run in dispatch.
  const mcpResponse = await handleMcp(req, env, { actor, role: principalRole, enforce: enforceAuth });
  if (mcpResponse) return mcpResponse;

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

// Boot-time active-seam log line (#260) — logged once per worker instance (mirrors the auth-handler
// memoization pattern above), not once per request. Descriptive only: it reports what the existing
// resolve* predicates already decide, never a second parse of the env vars.
let seamInventoryLogged = false;
function logSeamInventoryOnce(env: Env): void {
  if (seamInventoryLogged) return;
  seamInventoryLogged = true;
  console.log(`[workwell] ${formatSeamLogLine(env)}`);
}

export default {
  async fetch(req: Request, env: Env, _ctx: CloudExecutionContext): Promise<Response> {
    logSeamInventoryOnce(env);
    const origins = parseAllowedOrigins(env.WORKWELL_CORS_ALLOWED_ORIGINS);
    // CORS preflight must be answered before auth — browsers send OPTIONS without
    // credentials, so the real cross-site login/API call is blocked otherwise.
    if (req.method === "OPTIONS") return preflightResponse(req, origins);
    let response: Response;
    try {
      response = await route(req, env, _ctx);
    } catch (err) {
      // An unhandled error would otherwise surface as the host harness's bare, empty-body 500
      // (which made the Neon-pooler bug hard to diagnose). Log it with request context to the
      // container's stdout, and return a non-empty structured 500 (no internals leaked to clients).
      console.error(`[workwell] unhandled error: ${req.method} ${new URL(req.url).pathname} —`, err);
      response = json({ error: "internal_error" }, 500);
    }
    return withCors(response, req, origins);
  },
};
