/**
 * Where this suite is pointed, resolved ONCE so nothing can disagree about it.
 *
 * `playwright.config.ts` uses it for the browser's `baseURL` and `tests/maui/helpers.ts` uses it to
 * decide whether a spec may write. Those two once had different defaults, so a run with no environment
 * set drove a browser at one host while the write guard reasoned about another. The fallback is stated
 * once, here: the local stack CI and a developer boot.
 */
export const DEFAULT_BASE_URL = "http://localhost:3000";

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? DEFAULT_BASE_URL;

/**
 * Whether a URL names a stack on this machine.
 *
 * Host EQUALITY, never `includes("localhost")`: a deployed host is allowed to contain that string, and
 * a check a substring can fool is not a check. An unparseable URL is not local — the cost of saying no
 * is a skipped test, and the cost of saying yes is a write to somebody else's stack.
 */
export function isLocalStack(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
