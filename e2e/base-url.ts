/**
 * Where this suite is pointed, resolved ONCE so nothing can disagree about it.
 *
 * `playwright.config.ts` uses it for the browser's `baseURL` and `tests/maui/helpers.ts` uses it to
 * decide whether a spec may write. Those two lived apart until 2026-09-13, with different defaults —
 * the config fell back to the staging host and the helper to `http://localhost:3000` — so a run with
 * no environment set would have driven a browser against staging while the write guard read the
 * fallback and concluded it was talking to a local stack. A guard that can be wrong about which
 * machine it is protecting is the vacuous-guard shape this project keeps collecting, so the fallback
 * is stated once, here.
 *
 * STAGING by default, never production: this suite can mutate, and those writes land in the audit log
 * of whatever stack it points at.
 */
export const DEFAULT_BASE_URL = "https://twh-staging.os.mieweb.org";

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
