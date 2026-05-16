"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const TOKEN_KEY = "ww_token";
const USER_KEY = "ww_user";

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

function readStoredSession(): StoredSession {
  const token = readStorage<string>(TOKEN_KEY);
  const user = readStorage<AuthUser>(USER_KEY);
  if (!token || !user) {
    return { token: null, user: null };
  }

  try {
    const payload = decodeJwtPayload(token);
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || Date.now() >= exp * 1000) {
      return { token: null, user: null };
    }
  } catch {
    return { token: null, user: null };
  }

  return { token, user };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // Always initialize with null so server and client initial renders match (prevents hydration error #418).
  // localStorage is read after mount in the effect below.
  const [session, setSession] = useState<StoredSession>({ token: null, user: null });
  const [mounted, setMounted] = useState(false);
  const token = session.token;
  const user = session.user;

  useEffect(() => {
    const stored = readStoredSession();
    setSession(stored);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (pathname?.startsWith("/login")) return;
    if (!token) {
      router.replace("/login");
    }
  }, [pathname, router, token, mounted]);

  useEffect(() => {
    if (!mounted) return;
    if (token) return;
    const storedToken = readStorage<string>(TOKEN_KEY);
    const storedUser = readStorage<AuthUser>(USER_KEY);
    if (!storedToken && !storedUser) return;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }, [token, mounted]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      login: (nextToken, email, role) => {
        localStorage.setItem(TOKEN_KEY, JSON.stringify(nextToken));
        localStorage.setItem(USER_KEY, JSON.stringify({ email, role }));
        setSession({ token: nextToken, user: { email, role } });
      },
      logout: () => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        setSession({ token: null, user: null });
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
