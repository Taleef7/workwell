/**
 * Where to go back to after signing in, for the MCP consent page (`/oauth/consent`).
 *
 * Only a path on this origin is accepted, judged by resolving it: `new URL(next, origin).origin === origin`.
 * A "starts with `/`" rule lets `//evil.example`, `/\evil.example` and a tab-prefixed `/\t/evil.example`
 * through, because browsers normalise those into another host.
 */
export function safeNext(next: string | null | undefined, origin: string): string | null {
  if (!next || !next.startsWith("/")) return null;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** The login page, remembering an OAuth page to come back to; every other page signs in to its home. */
export function loginHref(pathname: string | null | undefined, search: string): string {
  if (!pathname?.startsWith("/oauth/")) return "/login";
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}
