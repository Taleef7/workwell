/**
 * The API's public origin (`WORKWELL_PUBLIC_API_URL`), from which the MCP resource identifier is built (#704).
 *
 * MCP 2026-07-28 makes the token's audience the server's own resource URL, and OAuth's Protected Resource
 * Metadata must name exactly the URL a client connects to. Behind MIE's proxy the request's own URL is not
 * that, so the origin is configured. It is validated (https, or http on a loopback host; an origin with no
 * path or trailing slash). When auth is enabled there is no fallback to the request's origin: a Host header
 * is the caller's to choose, and a token minted for a guessed resource would be valid somewhere else.
 *
 * A missing or bad value disables only MCP and its token routes (503), never the rest of the API.
 */
export type PublicApiUrl = { ok: true; origin: string } | { ok: false; reason: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function publicApiUrl(env: { WORKWELL_PUBLIC_API_URL?: string }, request: Request, authEnabled: boolean): PublicApiUrl {
  const raw = (env.WORKWELL_PUBLIC_API_URL ?? "").trim();
  if (!raw) {
    if (authEnabled) return { ok: false, reason: "WORKWELL_PUBLIC_API_URL is not set" };
    return { ok: true, origin: new URL(request.url).origin };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "WORKWELL_PUBLIC_API_URL is not a URL" };
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure) return { ok: false, reason: "WORKWELL_PUBLIC_API_URL must be https (http only on a loopback host)" };
  if (url.origin !== raw) return { ok: false, reason: "WORKWELL_PUBLIC_API_URL must be an origin: no path, query or trailing slash" };
  return { ok: true, origin: url.origin };
}

/** The MCP resource identifier: the endpoint's own URL. */
export const mcpResourceOf = (origin: string): string => `${origin}/mcp`;
