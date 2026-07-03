"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";

const TOKEN_KEY = "ww_token";
const USER_KEY = "ww_user";
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
const PUBLIC_ROUTES = ["/", "/sandbox"];

type AuthUser = {
  email: string;
  role: string;
};

type StoredSession = {
  token: string | null;
  user: AuthUser | null;
};

type AuthContextValue = {
  token: string | null;
  user: AuthUser | null;
  login: (token: string, email: string, role: string) => void;
  logout: () => void;
  /** Propagate a silently-refreshed access token into the session store (Fable M24) — keeps the
   *  existing user, swaps only the token, and notifies so every `useApi` client rebuilds with it. */
  updateToken: (token: string) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readStorage<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const base64Url = parts[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

// Module-level snapshot cache — useSyncExternalStore uses Object.is to detect
// changes, so returning a new object on every call causes an infinite re-render
// loop in React 19. We return the same reference when values haven't changed.
let _lastSession: StoredSession = { token: null, user: null };

function readStoredSession(): StoredSession {
  const rawToken = readStorage<string>(TOKEN_KEY);
  const rawUser = readStorage<AuthUser>(USER_KEY);

  let nextToken: string | null = null;
  let nextUser: AuthUser | null = null;

  if (rawToken && rawUser) {
    try {
      const payload = decodeJwtPayload(rawToken);
      const exp = Number(payload?.exp);
      if (Number.isFinite(exp) && Date.now() < exp * 1000) {
        nextToken = rawToken;
        nextUser = rawUser;
      }
    } catch {
      // invalid token — keep nulls
    }
  }

  if (
    _lastSession.token === nextToken &&
    _lastSession.user?.email === nextUser?.email &&
    _lastSession.user?.role === nextUser?.role
  ) {
    return _lastSession;
  }

  _lastSession = { token: nextToken, user: nextUser };
  return _lastSession;
}

// Module-level listener bus for same-tab localStorage changes.
// useSyncExternalStore requires a subscribe function; we emit here on login/logout.
const sessionListeners = new Set<() => void>();
function notifySessionChange() {
  for (const fn of sessionListeners) fn();
}
function subscribeToSession(callback: () => void) {
  sessionListeners.add(callback);
  return () => { sessionListeners.delete(callback); };
}

// Server snapshot: always null during SSR so server and client initial renders match,
// eliminating React hydration error #418. React transitions to readStoredSession()
// on the client after hydration via useSyncExternalStore.
const serverSnapshot: StoredSession = { token: null, user: null };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const session = useSyncExternalStore(subscribeToSession, readStoredSession, () => serverSnapshot);
  const token = session.token;
  const user = session.user;

  // Prevents the silent refresh from racing with an explicit logout: set before
  // clearing storage so the re-render triggered by notifySessionChange() skips refresh.
  // Reset by login() so the next token expiry after re-authentication still tries refresh.
  const logoutInProgress = useRef(false);

  // Prevents looping: only one silent-refresh attempt per unauthenticated state.
  // Reset when token becomes valid (after login or successful refresh).
  const silentRefreshAttempted = useRef(false);

  useEffect(() => {
    if (token) {
      silentRefreshAttempted.current = false;
    }
  }, [token]);

  useEffect(() => {
    if (pathname && PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
      return;
    }
    if (pathname?.startsWith("/login")) return;
    if (token) return;

    // logout() already called router.replace("/login") and will handle the redirect.
    if (logoutInProgress.current) return;

    // Hydration can briefly render token=null before the external-store snapshot
    // reconciles with localStorage. If a valid session already exists there,
    // re-emit a session change instead of clearing credentials or forcing refresh.
    const latestSession = readStoredSession();
    if (latestSession.token && latestSession.user) {
      notifySessionChange();
      return;
    }

    // Only one refresh attempt per unauthenticated epoch.
    if (silentRefreshAttempted.current) {
      router.replace("/login");
      return;
    }
    silentRefreshAttempted.current = true;

    // Clear stale expired credentials (either key missing = inconsistent state).
    const storedToken = readStorage<string>(TOKEN_KEY);
    const storedUser = readStorage<AuthUser>(USER_KEY);
    if (storedToken || storedUser) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      notifySessionChange();
    }

    fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      credentials: "include",
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ token?: string; email?: string; role?: string }>) : null))
      .then((payload) => {
        if (payload?.token && payload.email && payload.role) {
          localStorage.setItem(TOKEN_KEY, JSON.stringify(payload.token));
          localStorage.setItem(USER_KEY, JSON.stringify({ email: payload.email, role: payload.role }));
          notifySessionChange();
        } else {
          router.replace("/login");
        }
      })
      .catch(() => {
        router.replace("/login");
      });
  }, [pathname, router, token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      login: (nextToken, email, role) => {
        logoutInProgress.current = false;
        localStorage.setItem(TOKEN_KEY, JSON.stringify(nextToken));
        localStorage.setItem(USER_KEY, JSON.stringify({ email, role }));
        notifySessionChange();
      },
      updateToken: (nextToken: string) => {
        // A silent per-request refresh (client.ts) obtained a fresh access token: persist it under the
        // existing session so useSyncExternalStore re-emits and every useApi client rebuilds with it
        // (Fable M24). No-op if there's no current session (a concurrent logout won the race).
        const storedUser = readStorage<AuthUser>(USER_KEY);
        if (!storedUser || logoutInProgress.current) return;
        // Scope the refreshed token to the session that owns it (Codex P1): after a same-tab
        // logout-A → login-B, a late refresh from A must not overwrite B's token. The access token's
        // `sub` claim is the account email; only persist when it matches the current stored user.
        let subject: string | null = null;
        try {
          const payload = decodeJwtPayload(nextToken);
          subject = typeof payload?.sub === "string" ? payload.sub : null;
        } catch {
          return; // undecodable token — never persist
        }
        if (subject !== storedUser.email) return;
        localStorage.setItem(TOKEN_KEY, JSON.stringify(nextToken));
        notifySessionChange();
      },
      logout: () => {
        // Gate the refresh effect before clearing storage so the re-render it
        // triggers does not race to re-authenticate the user.
        logoutInProgress.current = true;
        // Best-effort: clear the HttpOnly refresh cookie server-side. The local
        // session is cleared regardless of whether the network call succeeds.
        void fetch(`${API_BASE}/api/auth/logout`, {
          method: "POST",
          credentials: "include"
        }).catch(() => {
          /* ignore network errors on logout */
        });
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        notifySessionChange();
        router.replace("/login");
      }
    }),
    [router, token, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
