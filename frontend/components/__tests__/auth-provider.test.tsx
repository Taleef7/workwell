/**
 * Unit tests for AuthProvider silent-refresh-on-load behaviour.
 *
 * We verify three observable contracts:
 *  1. Expired token + successful refresh → new credentials written to localStorage, no redirect.
 *  2. Expired token + failed refresh (non-2xx) → router.replace("/login") called.
 *  3. Expired token + network error → router.replace("/login") called.
 *  4. Logout in progress → refresh skipped, redirect not duplicated by the effect.
 *  5. Refresh attempted only once per unauthenticated epoch (silentRefreshAttempted guard).
 *  6. Public routes (`/` and `/sandbox`) do not trigger refresh or redirect.
 */

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { server } from "../../test/msw/server";
import { AuthProvider, useAuth } from "../auth-provider";

// ── Next.js navigation mocks ──────────────────────────────────────────────────
const mockReplace = vi.fn();
const mockPathname = vi.fn<() => string>().mockReturnValue("/programs");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => mockPathname(),
}));

// ── localStorage helpers ──────────────────────────────────────────────────────
const TOKEN_KEY = "ww_token";
const USER_KEY = "ww_user";

function buildJwt(exp: number, sub = "admin@workwell.dev"): string {
  // Minimal 3-part JWT-shaped string with a base64-encoded payload containing exp + sub.
  const payload = btoa(JSON.stringify({ exp, sub }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${payload}.sig`;
}

const expiredToken = buildJwt(Math.floor(Date.now() / 1000) - 120);
const freshToken = buildJwt(Math.floor(Date.now() / 1000) + 900);

function storeExpiredSession() {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(expiredToken));
  localStorage.setItem(USER_KEY, JSON.stringify({ email: "admin@workwell.dev", role: "ADMIN" }));
}

// ── Test setup ────────────────────────────────────────────────────────────────
beforeEach(() => {
  localStorage.clear();
  mockReplace.mockClear();
  mockPathname.mockReturnValue("/programs");
});

// ── Helper component ──────────────────────────────────────────────────────────
function TestApp({ onAuth }: { onAuth?: (ctx: ReturnType<typeof useAuth>) => void }) {
  const auth = useAuth();
  onAuth?.(auth);
  return <div data-testid="app">loaded</div>;
}

function renderProvider(onAuth?: (ctx: ReturnType<typeof useAuth>) => void) {
  return render(
    <AuthProvider>
      <TestApp onAuth={onAuth} />
    </AuthProvider>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AuthProvider — silent refresh on page load", () => {
  it("keeps an already-valid local session without forcing refresh or redirect", async () => {
    const validToken = freshToken;
    localStorage.setItem(TOKEN_KEY, JSON.stringify(validToken));
    localStorage.setItem(USER_KEY, JSON.stringify({ email: "admin@workwell.dev", role: "ADMIN" }));

    let refreshCallCount = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        refreshCallCount++;
        return HttpResponse.json({}, { status: 401 });
      })
    );

    renderProvider();

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(validToken));
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(refreshCallCount).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("writes new token/user to localStorage and does NOT redirect when refresh succeeds", async () => {
    storeExpiredSession();

    server.use(
      http.post("*/api/auth/refresh", () =>
        HttpResponse.json({ token: freshToken, email: "admin@workwell.dev", role: "ADMIN" })
      )
    );

    renderProvider();

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(freshToken));
    });
    expect(localStorage.getItem(USER_KEY)).toBe(
      JSON.stringify({ email: "admin@workwell.dev", role: "ADMIN" })
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects to /login when the refresh endpoint returns a non-2xx response", async () => {
    // Default MSW handler returns 401 — no server.use() override needed.
    renderProvider();

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("redirects to /login when the refresh fetch throws a network error", async () => {
    server.use(
      http.post("*/api/auth/refresh", () => HttpResponse.error())
    );

    renderProvider();

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });

  it("does not attempt refresh and does not redirect from the effect when logout is in progress", async () => {
    // Render with a valid (non-expired) session first so we can call logout().
    const validToken = freshToken;
    localStorage.setItem(TOKEN_KEY, JSON.stringify(validToken));
    localStorage.setItem(USER_KEY, JSON.stringify({ email: "admin@workwell.dev", role: "ADMIN" }));

    let capturedAuth: ReturnType<typeof useAuth> | null = null;
    renderProvider((auth) => { capturedAuth = auth; });

    // Wait for component to stabilise with a valid token (no redirect expected).
    await waitFor(() => {
      expect(capturedAuth?.token).not.toBeNull();
    });

    mockReplace.mockClear();

    // Call logout — sets logoutInProgress before clearing storage, then notifies session.
    act(() => { capturedAuth!.logout(); });

    // The effect re-runs because token becomes null, but logoutInProgress is true,
    // so it returns early without calling fetch('/api/auth/refresh').
    // logout() itself calls router.replace("/login") exactly once.
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });

  it("only attempts one refresh per unauthenticated epoch (silentRefreshAttempted guard)", async () => {
    // No token in storage. Default MSW handler returns 401.
    let refreshCallCount = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        refreshCallCount++;
        return HttpResponse.json({}, { status: 401 });
      })
    );

    renderProvider();

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });

    // Only one refresh call despite potential multiple effect executions.
    expect(refreshCallCount).toBe(1);
  });

  it("does not attempt refresh when on the /login route", async () => {
    mockPathname.mockReturnValue("/login");
    let refreshCallCount = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        refreshCallCount++;
        return HttpResponse.json({}, { status: 401 });
      })
    );

    renderProvider();

    // Give effects time to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(refreshCallCount).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not attempt refresh or redirect on the public landing route", async () => {
    mockPathname.mockReturnValue("/");
    let refreshCallCount = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        refreshCallCount++;
        return HttpResponse.json({}, { status: 401 });
      })
    );

    renderProvider();

    await new Promise((r) => setTimeout(r, 50));

    expect(refreshCallCount).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not attempt refresh or redirect on the sandbox route", async () => {
    mockPathname.mockReturnValue("/sandbox");
    let refreshCallCount = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        refreshCallCount++;
        return HttpResponse.json({}, { status: 401 });
      })
    );

    renderProvider();

    await new Promise((r) => setTimeout(r, 50));

    expect(refreshCallCount).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("Codex P1: updateToken ignores a refreshed token whose subject != the current session", async () => {
    // Session for admin@ is active.
    localStorage.setItem(TOKEN_KEY, JSON.stringify(freshToken)); // sub=admin@workwell.dev
    localStorage.setItem(USER_KEY, JSON.stringify({ email: "admin@workwell.dev", role: "ADMIN" }));
    let ctx: ReturnType<typeof useAuth> | null = null;
    renderProvider((c) => { ctx = c; });
    await waitFor(() => expect(ctx).not.toBeNull());

    // A late refresh from a DIFFERENT account (a same-tab logout→login-B race) must NOT overwrite the
    // current session's token.
    const foreignToken = buildJwt(Math.floor(Date.now() / 1000) + 900, "other@workwell.dev");
    act(() => ctx!.updateToken(foreignToken));
    expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(freshToken));

    // A refresh for the CURRENT account IS persisted (the happy path).
    const sameAcctToken = buildJwt(Math.floor(Date.now() / 1000) + 1800, "admin@workwell.dev");
    act(() => ctx!.updateToken(sameAcctToken));
    expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(sameAcctToken));
  });
});
