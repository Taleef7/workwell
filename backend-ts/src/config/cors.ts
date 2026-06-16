/**
 * CORS for the TS backend (#105) — port of SecurityConfig.corsConfigurationSource.
 *
 * The documented deployment is a split frontend/backend on different origins, so
 * every browser call is cross-site: the login fetch (and every authenticated fetch
 * carrying an `Authorization` header) is preceded by an `OPTIONS` preflight that must
 * be answered with CORS headers, or the browser blocks the real request before it
 * reaches any handler. Mirrors the Java config: exact allowed origins, credentials
 * enabled, methods GET/POST/PUT/PATCH/DELETE/OPTIONS.
 *
 * With credentials enabled the ACAO header must echo the specific origin (never `*`),
 * and Allow-Headers can't be `*` either — so the requested headers are echoed back.
 */
const DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000";
const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

export function parseAllowedOrigins(config: string | undefined): string[] {
  return (config ?? DEFAULT_ORIGINS)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Per-response CORS headers (empty when the request Origin isn't allowed). */
function originHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    // Let the browser read pagination metadata cross-origin (#150 M10 — the worklist X-Total-Count).
    "access-control-expose-headers": "X-Total-Count",
    vary: "Origin",
  };
}

/** Answer a CORS preflight (`OPTIONS`). Always 204; CORS headers only for allowed origins. */
export function preflightResponse(req: Request, allowed: string[]): Response {
  const requested = req.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      ...originHeaders(req, allowed),
      "access-control-allow-methods": ALLOW_METHODS,
      "access-control-allow-headers": requested && requested.trim() ? requested : "Authorization, Content-Type",
      "access-control-max-age": "3600",
    },
  });
}

/** Decorate an actual response with CORS headers so the browser can read it. */
export function withCors(res: Response, req: Request, allowed: string[]): Response {
  const extra = originHeaders(req, allowed);
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
