"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    if (pathname?.startsWith("/login")) {
      return;
    }
    if (!token) {
      router.replace("/login");
    }
  }, [pathname, router, token]);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const nextInit: RequestInit = { ...(init ?? {}) };
      const headers = new Headers(nextInit.headers ?? {});
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      nextInit.headers = headers;

      const response = await originalFetch(input, nextInit);
      if (response.status === 401 && !pathname?.startsWith("/login")) {
        setToken(null);
        setUser(null);
        router.replace("/login");
      }
      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [pathname, router, token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      login: (nextToken, email, role) => {
        setToken(nextToken);
        setUser({ email, role });
      },
      logout: () => {
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
