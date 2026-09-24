/**
 * Every refresh of the login runs through this lock, one browser tab at a time.
 *
 * A refresh ROTATES the HttpOnly refresh cookie, and the server treats a rotated-away cookie as a
 * stolen one: it ends the whole login, in every tab. Two tabs whose access tokens expire together
 * used to send the same cookie at once, so the second request looked like a replay and everyone was
 * signed out. The in-tab single-flight in `client.ts` cannot see another tab; the browser's Web
 * Locks API can. The second tab waits, and its request then carries the cookie the first one
 * received. Where the API is missing, the refresh runs as before.
 */
export const REFRESH_LOCK_NAME = "workwell-auth-refresh";

export async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== "function") return fn();
  return locks.request(REFRESH_LOCK_NAME, () => fn()) as Promise<T>;
}
