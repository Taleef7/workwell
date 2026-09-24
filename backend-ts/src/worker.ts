/**
 * WorkWell TS backend — worker entry (issue #96 / ADR-008; sole backend since the
 * #109 PR4 JVM retirement).
 *
 * The SAME module runs unchanged on every target (Cloudflare native, the
 * @mieweb/cloud-local Node host, and mieweb/os adapters) — see wrangler.jsonc
 * for the binding shapes and mieweb.jsonc for the per-target drivers.
 *
 * Every endpoint group is ported (#107/#108 strangler complete) behind the
 * unchanged frontend fetch contract (frontend/lib/api/client.ts). Persistence
 * goes through the storage contracts in src/stores (#104; SQLite floor /
 * Postgres ceiling); compliance goes through the EvaluateMeasure compute
 * binding in src/engine (#106).
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
import { handleProviders } from "./routes/providers.ts";
import { handlePanels } from "./routes/panels.ts";
import { handleSubjectLists } from "./routes/subject-lists.ts";
import { handlePayers } from "./routes/payers.ts";
import { handleWorklist } from "./routes/worklist.ts";
import { handleQuality } from "./routes/quality.ts";
import { handleIdentity } from "./routes/identity.ts";
import { handleCompliance } from "./routes/compliance.ts";
import { handleComplianceApi } from "./routes/compliance-api.ts";
import { handleCdsHooks } from "./routes/cds-hooks.ts";
import { handleCqlEvaluation } from "./routes/cql-evaluation.ts";
import { handleOpenApi } from "./routes/openapi.ts";
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
import { createAuthHandler, type AuthAuditEvent, type AuthHandler, type RefreshTokenRevocation } from "./routes/auth.ts";
import { getStores } from "./stores/factory.ts";
import { storeRefreshRevocation } from "./auth/store-refresh-revocation.ts";
import { createJwt, type JwtService } from "./auth/jwt.ts";
import { authorize, extractPrincipal, listFilterAuthorized } from "./auth/authorize.ts";
import { isDemoAccountRefusedOnProfile } from "./auth/demo-users.ts";
import { assertSafeStartup, type StartupEnv } from "./config/startup-safety.ts";
import { parseAllowedOrigins, preflightResponse, withCors } from "./config/cors.ts";
import { formatSeamLogLine } from "./config/seam-inventory.ts";
import { emitAlert, resolveAlertChannels } from "./run/alert-channel.ts";
import { probeEvidenceBucket, bucketAlert, partialBucketConfigAlert } from "./case/bucket-health.ts";
import { officialMeasureIds } from "./wiring/official-routing.ts";
import { officialRoutingProblems } from "./wiring/executor-router.ts";
import { loadOfficialArtifact } from "./wiring/official-artifacts.ts";
import { effectivePeriodWarning, officialMeasurementPeriod } from "./wiring/official-executor-adapter.ts";
import { RUNNABLE_MEASURE_IDS, classifyRunnable } from "./config/deployment-profile.ts";
import { isWebChartConfigured, webChartConfigFromEnv } from "./engine/ingress/data-source.ts";
import { classifyDbFailure } from "./stores/postgres/pg-database.ts";
import { runtimeDetail, runtimeHealth, trackRequest } from "./admin/runtime-health.ts";

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
  /** WebChart data-ingress seam (#184 E12). Inert unless base URL + API key or SMART credentials are set. */
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;
  WORKWELL_WEBCHART_CLIENT_ID?: string;
  WORKWELL_WEBCHART_PRIVATE_KEY?: string;
  WORKWELL_WEBCHART_TOKEN_URL?: string;
  WORKWELL_WEBCHART_SCOPE?: string;
  WORKWELL_WEBCHART_KID?: string;
  WORKWELL_WEBCHART_ENROLLMENT_JSON?: string;
  /** Measure-executor seam (#78 E9; ADR-025). FHIR-native default; "sql-pushdown" is an inert opt-in stub. */
  WORKWELL_MEASURE_EXECUTOR?: string;
  /** VSAC value-set resolution (ADR-023). Inert (local-store-only) unless the key is set. */
  WORKWELL_VSAC_API_KEY?: string;
  WORKWELL_VSAC_BASE_URL?: string;
  /** Failed-run alert webhook (#264). Inert unless set — console WORKWELL_ALERT line always fires. */
  WORKWELL_ALERT_WEBHOOK_URL?: string;
  /** Durable S3 evidence bucket (#167/ADR-030). Inert (in-container BUCKET binding) unless bucket + key id + secret are ALL set. */
  WORKWELL_BUCKET_S3_BUCKET?: string;
  WORKWELL_BUCKET_S3_ACCESS_KEY_ID?: string;
  WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY?: string;
  WORKWELL_BUCKET_S3_REGION?: string;
  WORKWELL_BUCKET_S3_ENDPOINT?: string;
  /** #263 incremental/delta evaluation opt-in. Inert unless "true". */
  WORKWELL_INCREMENTAL_EVAL?: string;
  /**
   * Per-measure official execution (PR-7b). Comma-separated catalog ids, never "all". Unset ⇒ every
   * measure evaluates through the authored CQL, byte-identical to before. Declared here — rather than
   * left to the optional fields of `OfficialMeasuresEnv` — because it being absent from a typed env
   * object is exactly how it went missing from the scheduler's allowlist.
   */
  WORKWELL_OFFICIAL_MEASURES?: string;
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
    revocation: refreshRevocation(env), // server-side refresh rotation/logout revocation (M5), in the database (#688)
    audit: authAudit(env), // login-family events in audit_events, written before the store change (#688)
  });
  verifier = createJwt({ secret: env.WORKWELL_AUTH_JWT_SECRET! });
}

/**
 * Refresh-token revocation in the DATABASE (#688) wherever one is configured, so a deploy or restart no
 * longer signs every user out; the in-memory KV binding below only where there is no database.
 */
export function refreshRevocation(env: Pick<Env, "DATABASE_URL" | "DB" | "CACHE">): RefreshTokenRevocation | undefined {
  if (!(env.DATABASE_URL ?? "").trim() && !env.DB) return kvRefreshRevocation(env.CACHE);
  return storeRefreshRevocation(async () => (await getStores(env)).authFamilies);
}

/**
 * The login-family audit writer (#688): `entity_type='auth'`, the family as the entity, the account as
 * the actor. Only where the families themselves are in the database; the KV fallback holds nothing a
 * ledger entry would describe.
 */
export function authAudit(env: Pick<Env, "DATABASE_URL" | "DB">): ((event: AuthAuditEvent) => Promise<void>) | undefined {
  if (!(env.DATABASE_URL ?? "").trim() && !env.DB) return undefined;
  return async (event) => {
    await (await getStores(env)).events.appendAudit({
      eventType: event.type,
      entityType: "auth",
      entityId: event.family,
      actor: event.actor,
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: event.via ? { via: event.via } : {},
    });
  };
}

/**
 * Refresh-token revocation backed by the KV binding (Fable M5), used only when no database is configured. Keyed by token family; the value is
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
  // Since #663/#625 it also says WHICH build is answering, since when, and whether the event loop has
  // stalled — counts and timings only. Still DB-free and answered before the auth gate, because a
  // liveness probe cannot hold a token; WHAT was running during a stall is on the ADMIN-gated
  // `/api/admin/runtime` and in the log, never here (runtime-health.ts, "WHAT IS PUBLIC").
  if (pathname === "/actuator/health" || pathname === "/health") {
    return json({ status: "UP", stack: "workwell-ts", ...runtimeHealth() });
  }

  // Version — parity with GET /api/version (unauthenticated discovery). `build` stays the image name it
  // always was, so a consumer reading it is unchanged; `sha` and `startedAt` are the identity it lacked.
  if (pathname === "/api/version") {
    const rt = runtimeHealth();
    return json({ api: "v1", stack: "typescript", build: "workwell-api-ts", sha: rt.build.sha, startedAt: rt.startedAt });
  }

  // The OpenAPI document (ADR-068) — served before the auth gate, like health and version, because it is
  // the contract an integrator reads before they have a token.
  const openApiResponse = handleOpenApi(req);
  if (openApiResponse) return openApiResponse;

  // Authorization gate — port of JwtAuthFilter + SecurityConfig (#105). Skipped
  // entirely when auth is disabled (no secret), mirroring authEnabled=false → permitAll.
  // The authenticated subject becomes the audit actor (SecurityActor.currentActor()).
  let actor = "system";
  let principalRole: string | null = null;
  const enforceAuth = authEnabled(env);
  if (enforceAuth) {
    let principal = extractPrincipal(req, getVerifier(env)!);
    // Profile rule, per request: a demo account from another deployment is refused even with a token
    // minted before the restriction. Service-account principals are not demo rows and pass through.
    if (principal && isDemoAccountRefusedOnProfile(principal.email)) {
      principal = null;
    }
    const decision = authorize(req.method, pathname, principal);
    if (!decision.ok) {
      return json({ error: decision.status === 403 ? "forbidden" : "unauthenticated" }, decision.status!);
    }
    if (principal?.email) actor = principal.email;
    principalRole = principal?.role ?? null;
    // `?listId=` narrows a read to an ACO's attributed membership, which is the same disclosure the
    // CM/ADMIN gate on /api/subject-lists exists to make — so it carries the same gate, once, here
    // (ADR-082). Without this the gate reads as present and cannot fire for the widest read: a VIEWER
    // with a list id could take the whole membership out of /api/exports/cases as a CSV.
    if (new URL(req.url).searchParams.has("listId") && !listFilterAuthorized(principalRole)) {
      return json(
        {
          error: "forbidden",
          parameter: "listId",
          message: "narrowing a read to an attributed list requires a case-manager or admin seat",
        },
        403,
      );
    }
  }

  // Auth — login/refresh/logout, JVM-free JWT + PBKDF2 (#105).
  const auth = getAuthHandler(env);
  if (auth) {
    const authResponse = await auth(req);
    if (authResponse) return authResponse;
  } else if (pathname.startsWith("/api/auth/")) {
    return json({ error: "auth_not_configured", hint: "WORKWELL_AUTH_JWT_SECRET is unset" }, 503);
  }

  // Runtime detail (#663): the recent stalls WITH the requests that were running, and what is running
  // now. ADMIN-only by the `/api/admin/**` rule above; `/health` carries only the counts.
  if (pathname === "/api/admin/runtime" && req.method === "GET") return json(runtimeDetail());

  // Measures — catalog + authoring (persisted store) + live CQL/eCQM evaluation (no JVM), #106/#107.
  const measuresResponse = await handleMeasures(req, env, actor);
  if (measuresResponse) return measuresResponse;

  // Runs — live through RunStore → CloudDatabase (SQLite floor). Spike, #103. ALL_PROGRAMS/SITE
  // finish in the background via ctx.waitUntil (long fan-out); the page polls to terminal.
  const runsResponse = await handleRuns(req, env, actor, (p) => ctx.waitUntil(p));
  if (runsResponse) return runsResponse;

  // Cases — worklist + detail + actions over the cases upserted from run outcomes (#107).
  // Patient-first work list + bulk assign (MM-2). Registered BEFORE the cases route because
  // `/api/cases/bulk-assign` sits under a path that route owns: it falls through today (none of its
  // case-action patterns match a single trailing segment), but that is a property of the patterns
  // rather than a guarantee, and the next `/api/cases/*` action added there would capture this path
  // silently. Ownership is declared here instead of depending on that.
  const worklistResponse = await handleWorklist(req, env as never, actor);
  if (worklistResponse) return worklistResponse;

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
  const tenantsResponse = await handleTenants(req, env);
  if (tenantsResponse) return tenantsResponse;

  const providersResponse = await handleProviders(req);
  if (providersResponse) return providersResponse;

  // Panels — which staff account works which provider's patients (MM-2 PR 2, ADR-080). Reads are
  // AUTHENTICATED like the rest of the directory; writes are CASE_MANAGER/ADMIN and audited.
  const panelsResponse = await handlePanels(req, env, actor);
  if (panelsResponse) return panelsResponse;

  // Attributed patient lists (MM-2 PR 3, ADR-082) — the ACO's own list of who the group is
  // responsible for. EVERY method is CM/ADMIN, metadata included: a member row is a raw identifier
  // another system asserted. Import is refused outright on a live-directory deployment.
  const subjectListsResponse = await handleSubjectLists(req, env, actor);
  if (subjectListsResponse) return subjectListsResponse;

  // Payers — the insurance list the panel filters are populated from (MM-2). Profile-scoped and
  // empty on a deployment whose roster records no payer.
  const payersResponse = await handlePayers(req);
  if (payersResponse) return payersResponse;

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

  // The versioned compliance API (M-C / C3, ADR-061) — the contract MIE consumes. Placed BEFORE the
  // roster so the `/api/v1/` prefix is matched by its own handler rather than falling through the
  // internal surface; the two paths cannot collide, but the ordering makes that structural.
  const complianceApiResponse = await handleComplianceApi(req, env, principalRole, actor);
  if (complianceApiResponse) return complianceApiResponse;

  // CDS Hooks (ADR-067) — the standards-shaped delivery of the same answer the compliance API returns, for
  // a CDS client rather than an integrator. Placed beside it because they are the same contract surface;
  // `/cds-services` is outside `/api/`, so it cannot collide with anything above.
  const cdsResponse = await handleCdsHooks(req, env, actor);
  if (cdsResponse) return cdsResponse;

  // The `$cql` Evaluation Service (#474) — the CQL IG operation `cql-tests-runner` drives for engine
  // parity testing. Data-free evaluation only; also outside `/api/`, with its own authorize rule
  // (same hazard and same remedy as CDS Hooks above).
  const cqlResponse = await handleCqlEvaluation(req);
  if (cqlResponse) return cqlResponse;

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

  // Unknown route. Be honest (no faked behavior), the same principle as
  // UnsupportedBindingError / "AI never decides compliance". 501 (not 404) is the
  // long-standing contract for unrouted /api paths — kept stable for probes/tooling.
  return json(
    {
      error: "not_implemented",
      path: pathname,
      hint: "No such API route — the full v1 surface is documented in docs/ARCHITECTURE.md §7",
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
  if (isWebChartConfigured(env)) {
    const webChart = webChartConfigFromEnv(env)!;
    console.log(`[workwell] webchart live tenant: enabled (host ${new URL(webChart.baseUrl).host})`);
  }
  // PR-7b: BOOT-LOUD, not merely construction-time. `routedEngineForEnv` validates lazily, so a typo'd
  // WORKWELL_OFFICIAL_MEASURES would otherwise boot clean, log `official-measures=on`, serve
  // /actuator/health 200 (deliberately DB-free, so the 15-minute reconciler reports green) and return
  // `internal_error` from every evaluating route — character-for-character the symptom profile of the
  // four-day Neon outage that DEPLOY.md's "Watch the right signal" section exists because of.
  //
  // Alerted rather than thrown: the worker's fetch handler is not a startup hook, so throwing here
  // would fail one arbitrary request rather than the process. The alert line is the one an operator
  // greps for, and every affected route still refuses loudly at construction.
  const problems = officialRoutingProblems(env);
  if (problems.length > 0) {
    console.error(
      `WORKWELL_ALERT ${JSON.stringify({ kind: "OFFICIAL_ROUTING_MISCONFIGURED", problems })}`,
    );
  }
  // #473: the evidence bucket is CONFIGURED but only exercised on the first evidence operation, so a
  // dead one is silent. On 2026-08-24 the hosting AWS account lapsed and this stack went on booting
  // clean, logging `bucket-s3=on` and serving /actuator/health 200 for eighteen days while every
  // evidence write failed — the nightly backup job noticed on night one only because it opens a real
  // connection. This is the app's equivalent: one read of a key that need not exist.
  //
  // Fire-and-forget, and alerted rather than thrown, for the same reason as the routing check above —
  // the fetch handler is not a startup hook, so throwing would fail one arbitrary request instead of
  // the process. `void` rather than `await` because no request should wait on a storage round trip.
  // A half-configured bucket is reported BEFORE the probe, because the probe cannot see it: the seam
  // needs all three vars, so a named bucket with an empty key reads as "off" and returns
  // `not-configured`. Silence there is the same failure mode with a different cause.
  const partial = partialBucketConfigAlert(env);
  if (partial) {
    void emitAlert(resolveAlertChannels(env), partial).catch((err) => {
      console.error(`[workwell] evidence-bucket config alert failed: ${String((err as Error)?.message ?? err)}`);
    });
  }
  void probeEvidenceBucket(env)
    .then(async (result) => {
      const alert = bucketAlert(result);
      if (alert) await emitAlert(resolveAlertChannels(env), alert);
      else if (result.kind === "reachable") console.log("[workwell] evidence bucket: reachable");
    })
    .catch((err) => {
      // probeEvidenceBucket never rejects, so reaching here means emitAlert did. Swallowing that
      // silently would make the alerting path itself the next thing to fail unnoticed.
      console.error(`[workwell] evidence-bucket probe alert failed: ${String((err as Error)?.message ?? err)}`);
    });
  // ADR-072: report the runnable classification and a stale vendored effectivePeriod at boot, so an
  // operator sees the vintage gap before the first run reports it.
  const today = new Date().toISOString().slice(0, 10);
  for (const measureId of officialMeasureIds(env as unknown as Record<string, unknown>)) {
    const artifact = loadOfficialArtifact(measureId);
    const warning = artifact
      ? effectivePeriodWarning(artifact, officialMeasurementPeriod(measureId, today))
      : null;
    if (warning) console.warn(`[workwell] ${warning}`);
  }
  console.log(
    `[workwell] runnable=${RUNNABLE_MEASURE_IDS.map((id) => `${id}:${classifyRunnable(id, env as unknown as Record<string, unknown>).kind}`).join(",")}`,
  );
}

/** What a caller is told for each classified database failure — fixed text, never the driver's. */
const DB_FAILURE_MESSAGE: Record<string, string> = {
  statement_timeout: "The database cancelled this query for exceeding its time limit. Narrow the request or try again.",
  query_canceled: "The database cancelled this query. Try again.",
  pool_exhausted: "No database connection was available in time. Try again shortly.",
};

/**
 * Keep a request registered as in flight until its BODY has been read or cancelled, not merely until
 * the handler returned (#663). The CSV exports stream — their work happens as the body is pulled, long
 * after `route` resolved — and a request that never finishes streaming is exactly what a stall needs to
 * be attributed to.
 */
function untrackWhenBodySettles(response: Response, settle: () => void): Response {
  // Headers FIRST: on the host's lightweight Response, reading `.body` rebuilds the real response from
  // its original init and would drop any header changed after construction.
  const { status, statusText, headers } = response;
  if (!response.body) {
    settle();
    return response;
  }
  let settled = false;
  const once = () => {
    if (!settled) {
      settled = true;
      settle();
    }
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        // Cancelled while this read was pending: the stream is closed, and touching the controller
        // again would throw into the catch below for nothing.
        if (settled) return;
        if (done) {
          once();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        once();
        controller.error(err);
      }
    },
    cancel(reason) {
      once();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status, statusText, headers });
}

export default {
  async fetch(req: Request, env: Env, _ctx: CloudExecutionContext): Promise<Response> {
    logSeamInventoryOnce(env);
    const origins = parseAllowedOrigins(env.WORKWELL_CORS_ALLOWED_ORIGINS);
    // CORS preflight must be answered before auth — browsers send OPTIONS without
    // credentials, so the real cross-site login/API call is blocked otherwise.
    if (req.method === "OPTIONS") return preflightResponse(req, origins);
    // Health polls are the one request that is never a stall's cause, and they arrive every few seconds
    // from probes: registering them would only crowd the in-flight list a stall report reads.
    const { pathname } = new URL(req.url);
    if (pathname === "/health" || pathname === "/actuator/health") {
      return withCors(await route(req, env, _ctx), req, origins);
    }
    const settle = trackRequest(req.method, req.url);
    // A client that disconnects before its response is ready leaves a body the host never reads or
    // cancels, so the body-settle path below would never fire and the request would read as running
    // for hours in every later stall report. Settle on disconnect — but only once the handler has
    // returned: a handler still burning CPU after its client left is exactly a stall's cause.
    let handlerReturned = false;
    // A signal already aborted never fires its listener, so read the state too (Gemini review, #675).
    let clientGone = req.signal?.aborted === true;
    req.signal?.addEventListener(
      "abort",
      () => {
        clientGone = true;
        if (handlerReturned) settle();
      },
      { once: true },
    );
    let response: Response;
    try {
      response = await route(req, env, _ctx);
    } catch (err) {
      // An unhandled error would otherwise surface as the host harness's bare, empty-body 500
      // (which made the Neon-pooler bug hard to diagnose). Log it with request context to the
      // container's stdout, and return a non-empty structured 500 (no internals leaked to clients).
      const path = new URL(req.url).pathname;
      // Two database failures answer for themselves (#562). Before this they arrived as a generic 500,
      // or — for pool starvation, which has no timeout of its own by default — as a 60 s gateway 504
      // with nothing in the log at all. 503 rather than 500: both are "ask again", not "this request
      // is wrong", and a caller can act on the difference.
      const dbFailure = classifyDbFailure(err);
      if (dbFailure) {
        // `err` is passed too, not just the reason: for a statement timeout the reason is the fixed
        // server string "canceling statement due to statement timeout", which names neither the
        // statement nor the call site — and these routes issue many. The stack is the only thing that
        // identifies WHICH query ran long, and losing it would defeat the point of classifying at all.
        console.error(`[workwell] ${dbFailure.error}: ${req.method} ${path} — ${dbFailure.reason}`, err);
        // The CLIENT gets the class and a fixed phrase. The branch this replaced returned
        // `internal_error` with "no internals leaked to clients", and a driver or server string is an
        // internal: today's three are harmless fixed text, but a future wrapped error's `.message`
        // could carry query text, and it would ship straight through.
        response = json({ error: dbFailure.error, message: DB_FAILURE_MESSAGE[dbFailure.error] }, 503);
      } else {
        // An unhandled error would otherwise surface as the host harness's bare, empty-body 500
        // (which made the Neon-pooler bug hard to diagnose). Log it with request context to the
        // container's stdout, and return a non-empty structured 500 (no internals leaked to clients).
        console.error(`[workwell] unhandled error: ${req.method} ${path} —`, err);
        response = json({ error: "internal_error" }, 500);
      }
    }
    handlerReturned = true;
    if (clientGone) {
      settle();
      return withCors(response, req, origins);
    }
    return untrackWhenBodySettles(withCors(response, req, origins), settle);
  },
};
