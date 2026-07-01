/**
 * Request authorization (#105) — TS port of JwtAuthFilter + the SecurityConfig
 * authorizeHttpRequests matrix. JVM-free.
 *
 * `extractPrincipal` reads a `Bearer` access token (refresh tokens are rejected by
 * the JWT layer). `authorize` resolves the first matching rule, Spring-style, and
 * returns 401 (unauthenticated) or 403 (authenticated but missing the required
 * authority), or ok. Public routes (auth + health/version) are permitted.
 */
import type { JwtPrincipal, JwtService } from "./jwt.ts";

export function extractPrincipal(req: Request, jwt: JwtService): JwtPrincipal | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return jwt.verifyAccessToken(header.slice(7));
}

type Access = "PERMIT" | "AUTHENTICATED" | string[]; // string[] = allowed authorities
interface Rule {
  method?: string; // undefined = any method
  pattern: RegExp;
  access: Access;
}

const A = "ROLE_ADMIN";
const APPROVER = "ROLE_APPROVER";
const AUTHOR = "ROLE_AUTHOR";
const CM = "ROLE_CASE_MANAGER";
const MCP = "ROLE_MCP_CLIENT";
const VIEWER = "ROLE_VIEWER"; // read-only (public /sandbox); may GET but never write

/**
 * Glob → anchored regex, Spring AntPathMatcher semantics:
 *   `*`   = exactly one path segment
 *   `/**` = zero or more trailing segments INCLUDING the base, so `/api/runs/**`
 *           matches `/api/runs`, `/api/runs/`, and `/api/runs/claim` alike.
 * `/**` is parked behind a private-use sentinel so the later `*`→segment rewrite
 * doesn't corrupt the `.*` it expands to.
 */
function rx(glob: string): RegExp {
  const GLOBSTAR = "\uE000"; // private-use char; never appears in a route glob
  const body = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*\*/g, GLOBSTAR)
    .replace(/\*\*/g, ".*") // bare "**"
    .replace(/\*/g, "[^/]+") // single segment
    .replaceAll(GLOBSTAR, "(?:/.*)?");
  return new RegExp(`^${body}$`);
}

// Ordered, first-match-wins — mirrors SecurityConfig. The two TS-only measure
// endpoints (GET .../elm, POST /compile from the ELM Explorer) are read-only and
// gated to AUTHENTICATED, placed before the generic author-only measures POST rule.
const RULES: Rule[] = [
  { pattern: rx("/api/auth/login"), access: "PERMIT" },
  { pattern: rx("/api/auth/refresh"), access: "PERMIT" },
  { pattern: rx("/api/auth/logout"), access: "PERMIT" },
  { pattern: rx("/actuator/health"), access: "PERMIT" },
  { pattern: rx("/api/health"), access: "PERMIT" },
  { pattern: rx("/api/version"), access: "PERMIT" },
  { pattern: rx("/health"), access: "PERMIT" },

  { pattern: rx("/sse"), access: [A, CM, MCP] },
  { pattern: rx("/mcp/**"), access: [A, CM, MCP] },
  { pattern: rx("/api/admin/**"), access: [A] },

  { method: "POST", pattern: rx("/api/cases/*/evidence"), access: [CM, A] },
  { method: "GET", pattern: rx("/api/cases/*/evidence"), access: [CM, A] },
  { method: "GET", pattern: rx("/api/evidence/*/download"), access: [CM, A] },

  { method: "POST", pattern: rx("/api/measures/*/approve"), access: [APPROVER, A] },
  { method: "POST", pattern: rx("/api/measures/*/activate"), access: [APPROVER, A] },
  { method: "POST", pattern: rx("/api/measures/*/deprecate"), access: [A] },
  { method: "POST", pattern: rx("/api/measures/*/status"), access: [APPROVER, A] },
  { method: "PUT", pattern: rx("/api/measures/*/spec"), access: [AUTHOR, A] },
  { method: "PUT", pattern: rx("/api/measures/*/cql"), access: [AUTHOR, A] },
  { method: "PUT", pattern: rx("/api/measures/*/rule"), access: [AUTHOR, A] },
  { method: "PUT", pattern: rx("/api/measures/*/tests"), access: [AUTHOR, A] },

  { method: "POST", pattern: rx("/api/measures/compile"), access: "AUTHENTICATED" },
  // Value-set governance writes (Studio Value Sets tab): create, attach (POST .../value-sets/*
  // matches the measures rule below), detach. Authoring-scoped → AUTHOR/ADMIN.
  { method: "POST", pattern: rx("/api/value-sets"), access: [AUTHOR, A] },
  { method: "DELETE", pattern: rx("/api/measures/*/value-sets/*"), access: [AUTHOR, A] },
  { method: "POST", pattern: rx("/api/measures/**"), access: [AUTHOR, A] },
  { method: "POST", pattern: rx("/api/runs/**"), access: [CM, A] },
  { method: "POST", pattern: rx("/api/cases/**"), access: [CM, A] },
  // Batch outreach campaigns (#75 E5) multiply per-case outreach over up to 100k cases —
  // they carry the same operational case/PII data, so ALL methods on /api/campaigns and
  // /api/campaigns/:id are gated to CASE_MANAGER/ADMIN (matching per-case outreach), not
  // left to the generic AUTHENTICATED /api/** fallback below. Any-method (no `method`),
  // `/api/campaigns/**` matches both the bare collection and sub-paths (AntPathMatcher).
  { pattern: rx("/api/campaigns/**"), access: [CM, A] },
  // Order proposals (#77 E7) — clinical decision support over case/PII data; gated like campaigns.
  { pattern: rx("/api/orders/**"), access: [CM, A] },

  // Identity (#187 E15) — the cross-system person directory exposes national/MRN ids + DOB and the
  // reconcile write mis-merges medical records if wrong, so ALL methods on /api/identity/** are
  // CASE_MANAGER/ADMIN (not left to the AUTHENTICATED /api/** fallback — which the public read-only
  // VIEWER sandbox would otherwise use to enumerate everyone's PII). Writes are additionally audited.
  { pattern: rx("/api/identity/**"), access: [CM, A] },

  // Segments (#183 E11.3) — risk-group config. Writes are ADMIN; reads (list + preview) fall through
  // to the AUTHENTICATED /api/** rule (the roster + admin editor both read them).
  { method: "POST", pattern: rx("/api/segments/**"), access: [A] },
  { method: "PUT", pattern: rx("/api/segments/**"), access: [A] },
  { method: "DELETE", pattern: rx("/api/segments/**"), access: [A] },

  { method: "GET", pattern: rx("/api/measures/*/traceability"), access: "AUTHENTICATED" },
  { method: "GET", pattern: rx("/api/measures/*/versions/*/export/mat"), access: [APPROVER, A] },

  // Auditor packets: run/case packets are case-operational (CM/ADMIN); measure-version
  // packets carry authoring/governance detail (APPROVER/ADMIN). Mirrors AuditorController.
  { method: "GET", pattern: rx("/api/auditor/runs/*/packet"), access: [CM, A] },
  { method: "GET", pattern: rx("/api/auditor/cases/*/packet"), access: [CM, A] },
  { method: "GET", pattern: rx("/api/auditor/measure-versions/*/packet"), access: [APPROVER, A] },
  { method: "GET", pattern: rx("/api/**"), access: "AUTHENTICATED" },
  { pattern: rx("/api/**"), access: "AUTHENTICATED" },
];

export interface AuthzDecision {
  ok: boolean;
  status?: 401 | 403;
}

export function authorize(method: string, pathname: string, principal: JwtPrincipal | null): AuthzDecision {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue;
    if (!rule.pattern.test(pathname)) continue;
    if (rule.access === "PERMIT") return { ok: true };
    if (!principal) return { ok: false, status: 401 };
    // Read-only sandbox role: ROLE_VIEWER may read (GET/HEAD) anything it is otherwise authorized for,
    // but never write — so the public /sandbox can browse without mutating shared demo state or
    // triggering compute. Public routes (login/refresh/logout/health) are PERMIT and already returned
    // above, so a viewer can still log out.
    if (principal.role === VIEWER && method !== "GET" && method !== "HEAD") return { ok: false, status: 403 };
    if (rule.access === "AUTHENTICATED") return { ok: true };
    return rule.access.includes(principal.role) ? { ok: true } : { ok: false, status: 403 };
  }
  return { ok: true }; // non-/api default permitAll (mirrors anyRequest().permitAll())
}
