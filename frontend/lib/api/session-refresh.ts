import { withRefreshLock } from "./refresh-lock";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

/**
 * The one way the app renews its access token, shared by the page-load refresh (`auth-provider.tsx`)
 * and the per-request one (`client.ts`).
 *
 * A refresh has THREE outcomes, and only one of them ends the session:
 *   - `ok`: a fresh access token.
 *   - `refused`: the refresh route answered 401 (the login was logged out, expired or replayed), the
 *     only refusal it sends. The session is over.
 *   - `unavailable`: anything else. A network error, a 5xx or an odd status from the proxy while a
 *     deploy replaces the container, a 503 while the pool is busy. The login may be perfectly good.
 *
 * Both callers used to treat any failure as `refused`, so every deploy signed out whoever's access
 * token lapsed while the backend restarted (#688 had already kept the login itself across restarts).
 * An `unavailable` refresh is retried with backoff for about two minutes, one lock-held attempt at a
 * time, so other tabs are never kept waiting behind the whole retry.
 */
export type RefreshResult =
  | { kind: "ok"; token: string; email?: string; role?: string }
  | { kind: "refused" }
  | { kind: "unavailable" };

/** Waits between attempts while the server cannot answer: ~2 minutes, which covers a Maui redeploy. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000];
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;

/** Test hook: shorter waits. `null` restores the defaults. */
export function __setRefreshRetryDelaysForTest(delays: number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

/**
 * Bumped by `cancelSessionRefresh` (a logout or a login): a refresh still retrying for the session
 * that ended stops at its next step instead of re-arming a refresh cookie in a signed-out browser.
 */
let generation = 0;

async function attempt(): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await withRefreshLock(() => fetch(`${API_BASE}/api/auth/refresh`, { method: "POST", credentials: "include" }));
  } catch {
    return { kind: "unavailable" };
  }
  if (res.status === 401) return { kind: "refused" };
  if (!res.ok) return { kind: "unavailable" };
  try {
    const payload = (await res.json()) as { token?: string; email?: string; role?: string };
    // A 2xx without a token is not a login the app can use; asking again would get the same answer.
    return payload.token ? { kind: "ok", token: payload.token, email: payload.email, role: payload.role } : { kind: "refused" };
  } catch {
    return { kind: "unavailable" }; // a truncated body, as a proxy cut mid-response gives
  }
}

async function refreshWithRetry(): Promise<RefreshResult> {
  const mine = generation;
  let result = await attempt();
  for (const delay of retryDelaysMs) {
    if (result.kind !== "unavailable") return result;
    await new Promise((resolve) => setTimeout(resolve, delay));
    // The session it was for ended (a logout, or a login as someone else). Stop without asking again,
    // and answer `unavailable`, never `refused`: a refusal would sign out whoever is signed in now.
    if (mine !== generation) return { kind: "unavailable" };
    result = await attempt();
  }
  return result;
}

/**
 * One refresh at a time per tab (Fable M24): parallel 401s share the in-flight one, since each refresh
 * ROTATES the cookie and a second concurrent call would present the rotated-away one. The slot clears
 * once it settles, so a later expiry starts a fresh refresh.
 */
let inFlight: Promise<RefreshResult> | null = null;
export function refreshSession(): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  const p = refreshWithRetry();
  inFlight = p;
  void p.finally(() => {
    if (inFlight === p) inFlight = null;
  });
  return p;
}

/** Stops any refresh still retrying, and lets the next one start fresh rather than join it. */
export function cancelSessionRefresh(): void {
  generation++;
  inFlight = null;
}
