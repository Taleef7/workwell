/**
 * Redirect URIs for the MCP authorization server.
 *
 * - **Which may be registered.** http only on a loopback host (`localhost`, `127.0.0.1`, `[::1]`), which is all a
 *   desktop client such as `mcp-remote` or Claude Code needs; https only for a client whose identity is the
 *   host of its fetched metadata document (CIMD). A self-registered (DCR) client may not use https: anyone can
 *   register under any name, so "Claude" with `https://attacker.example/cb` would turn a consent click into a
 *   stolen grant. No fragment, no userinfo, no other scheme.
 * - **How a request matches.** Exactly, character for character, except that a loopback http redirect may use
 *   any port (RFC 8252 §7.3; desktop clients pick a free port per session).
 */
export type ClientTrust = "cimd" | "dcr";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parse = (uri: string): URL | null => {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
};

const isLoopbackHttp = (url: URL): boolean => url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);

/** Why `uri` may not be registered by a client of this trust, or null when it may. */
export function redirectProblem(uri: string, trust: ClientTrust): string | null {
  const url = parse(uri);
  if (!url) return "not a URL";
  if (url.hash || uri.includes("#")) return "a redirect URI may not have a fragment";
  if (url.username || url.password) return "a redirect URI may not carry credentials";
  if (isLoopbackHttp(url)) return null;
  if (url.protocol === "https:") return trust === "cimd" ? null : "a self-registered client may only redirect to a loopback address";
  return "a redirect URI is https (verified clients) or http on localhost, 127.0.0.1 or [::1]";
}

/** True when `requested` is one of `registered`: exactly, or a loopback http one with any port. */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const want = parse(requested);
  if (!want || !isLoopbackHttp(want) || want.hash || want.username || want.password) return false;
  return registered.some((uri) => {
    const have = parse(uri);
    return (
      !!have &&
      isLoopbackHttp(have) &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** The origin a consent page shows for a redirect (scheme, host and port), so the user sees where the code goes. */
export const redirectOrigin = (uri: string): string => parse(uri)?.origin ?? uri;
