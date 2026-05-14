"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const TOKEN_KEY = "ww_token";
const USER_KEY = "ww_user";

type AuthUser = {
  email: string;
  role: string;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [token, setToken] = useState<string | null>(() => readStorage<string>(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(() => readStorage<AuthUser>(USER_KEY));

  useEffect(() => {
    if (pathname?.startsWith("/login")) return;
    if (!token) {
      router.replace("/login");
    }
  }, [pathname, router, token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      login: (nextToken, email, role) => {
        localStorage.setItem(TOKEN_KEY, JSON.stringify(nextToken));
        localStorage.setItem(USER_KEY, JSON.stringify({ email, role }));
        setToken(nextToken);
        setUser({ email, role });
      },
      logout: () => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        setToken(null);
        setUser(null);
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
