/**
 * Where to go back to after signing in: only the MCP consent page (`/oauth/consent`), the one page that sends a
 * signed-out visitor to /login and expects them back.
 *
 * Judged on the RESOLVED URL: same origin AND exactly that path. A same-origin check alone is not enough:
 * `/.//evil.example` resolves on this origin to the path `//evil.example`, which the router then treats as a
 * protocol-relative URL and leaves the app for. `//evil.example`, `/\evil.example` and a tab-prefixed
 * `/\t/evil.example` resolve to another host outright.
 */
const RETURN_PATHS = new Set(["/oauth/consent"]);

export function safeNext(next: string | null | undefined, origin: string): string | null {
  if (!next || !next.startsWith("/")) return null;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || !RETURN_PATHS.has(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** The login page, remembering the consent page to come back to; every other page signs in to its home. */
export function loginHref(pathname: string | null | undefined, search: string): string {
  if (!pathname || !RETURN_PATHS.has(pathname)) return "/login";
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}
