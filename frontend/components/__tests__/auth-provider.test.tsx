/**
 * Unit tests for AuthProvider silent-refresh-on-load behaviour.
 *
 * We verify three observable contracts:
 *  1. Expired token + successful refresh → new credentials written to localStorage, no redirect.
 *  2. Expired token + a refused refresh (401) → router.replace("/login") called.
 *  3. Expired token + a refresh the server could not answer (network error, 5xx) → retried, never
 *     sent to /login: a deploy restarting the backend is not a logout.
 *  4. Logout in progress → refresh skipped, redirect not duplicated by the effect.
 *  5. Refresh attempted only once per unauthenticated epoch (silentRefreshAttempted guard).
 *  6. Public routes (`/` and `/sandbox`) do not trigger refresh or redirect.
 */

import React from "react";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { act, render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { server } from "../../test/msw/server";
import { AuthProvider, PUBLIC_ROUTES, isPublicRoute, useAuth } from "../auth-provider";
import { __setRefreshRetryDelaysForTest } from "@/lib/api/session-refresh";

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
  __setRefreshRetryDelaysForTest([5, 5, 5]);
});

afterEach(() => {
  __setRefreshRetryDelaysForTest(null);
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
  it("refreshes on page load only while holding the cross-tab lock", async () => {
    storeExpiredSession();
    let held = false;
    let refreshedInsideLock: boolean | null = null;
    const request = vi.fn(async (_name: string, cb: () => Promise<unknown>) => {
      held = true;
      try {
        return await cb();
      } finally {
        held = false;
      }
    });
    vi.stubGlobal("navigator", { ...navigator, locks: { request } });
    server.use(
      http.post("*/api/auth/refresh", () => {
        refreshedInsideLock = held;
        return HttpResponse.json({ token: freshToken, email: "admin@workwell.dev", role: "ADMIN" });
      })
    );

    renderProvider();

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(freshToken));
    });
    expect(request).toHaveBeenCalledWith("workwell-auth-refresh", expect.any(Function));
    expect(refreshedInsideLock).toBe(true);
    vi.unstubAllGlobals();
  });

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

  it("redirects to /login when the refresh endpoint refuses (401)", async () => {
    // Default MSW handler returns 401 — no server.use() override needed.
    renderProvider();

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("keeps the login through a server restart: network errors and 502s are retried, not a logout", async () => {
    storeExpiredSession();
    let calls = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        calls++;
        if (calls === 1) return HttpResponse.error();
        if (calls <= 3) return new HttpResponse("Bad Gateway", { status: 502 });
        return HttpResponse.json({ token: freshToken, email: "admin@workwell.dev", role: "ADMIN" });
      })
    );

    renderProvider();

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(freshToken));
    });
    expect(calls).toBe(4);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("while the server stays unreachable it keeps retrying and says it is reconnecting, never /login", async () => {
    storeExpiredSession();
    let calls = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      })
    );

    let latest: ReturnType<typeof useAuth> | null = null;
    const { unmount } = renderProvider((auth) => { latest = auth; });

    // Past one whole retry budget (4 attempts), so the provider is on its second round.
    await waitFor(() => expect(calls).toBeGreaterThan(5));
    await waitFor(() => expect(latest?.reconnecting).toBe(true), { timeout: 3_000 });
    expect(mockReplace).not.toHaveBeenCalled();

    // Leaving the page ends the retrying; let the in-flight round settle before the next test.
    unmount();
    await new Promise((r) => setTimeout(r, 100));
    const settled = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(settled);
  });

  it("a navigation while it reconnects is not a second attempt, and does not send the user to /login", async () => {
    // Long enough waits that the navigation lands mid-outage.
    __setRefreshRetryDelaysForTest([40, 40, 40, 40, 40]);
    storeExpiredSession();
    let calls = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        calls++;
        return calls < 6
          ? new HttpResponse(null, { status: 502 })
          : HttpResponse.json({ token: freshToken, email: "admin@workwell.dev", role: "ADMIN" });
      })
    );

    const { rerender } = renderProvider();
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    mockPathname.mockReturnValue("/cases");
    rerender(
      <AuthProvider>
        <TestApp />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(freshToken));
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("a login made while it reconnects wins: the old login's late answer neither overwrites it nor ejects it", async () => {
    storeExpiredSession();
    let calls = 0;
    let refuseOld = false;
    server.use(
      http.post("*/api/auth/refresh", () => {
        calls++;
        if (refuseOld) return HttpResponse.json({ error: "invalid_refresh_token" }, { status: 401 });
        return new HttpResponse(null, { status: 502 });
      })
    );

    let latest: ReturnType<typeof useAuth> | null = null;
    renderProvider((auth) => { latest = auth; });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));

    // The user follows "Sign in again" and signs in as someone else; the server then answers the loop.
    const newToken = buildJwt(Math.floor(Date.now() / 1000) + 900, "new@workwell.dev");
    act(() => { latest!.login(newToken, "new@workwell.dev", "ADMIN"); });
    refuseOld = true;
    await new Promise((r) => setTimeout(r, 100));

    expect(localStorage.getItem(TOKEN_KEY)).toBe(JSON.stringify(newToken));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("a logout while it reconnects stops the refreshing at once", async () => {
    // Waits long enough that the round would still be firing after the logout if nothing cancelled it.
    __setRefreshRetryDelaysForTest([40, 40, 40, 40]);
    storeExpiredSession();
    let calls = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        calls++;
        return new HttpResponse(null, { status: 502 });
      })
    );

    let latest: ReturnType<typeof useAuth> | null = null;
    renderProvider((auth) => { latest = auth; });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));

    const atLogout = calls;
    act(() => { latest!.logout(); });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(atLogout);
  });

  it("a refusal after an outage still ends the session", async () => {
    storeExpiredSession();
    let calls = 0;
    server.use(
      http.post("*/api/auth/refresh", () => {
        calls++;
        return calls === 1 ? HttpResponse.error() : HttpResponse.json({ error: "invalid_refresh_token" }, { status: 401 });
      })
    );

    renderProvider();

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
    expect(calls).toBe(2);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
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

/**
 * The public-route allowlist, derived rather than enumerated.
 *
 * `/api-docs` shipped outside `app/(dashboard)/`, fetching without a token, and was still unreachable —
 * absent from `PUBLIC_ROUTES`, the provider redirected it to `/login`. Nothing caught it: the page's own
 * tests render the component directly, and an HTTP probe returns 200 because the redirect is client-side.
 *
 * So this walks `app/` for real `page` files instead of restating the list. Directory names are NOT URL
 * segments (review): a route group `(public)` contributes nothing to the URL, so scanning top-level
 * directory names would demand a nonexistent `/(public)` entry while never checking the `/help` a reader
 * would actually visit. Routes are resolved the way the App Router resolves them, and then checked
 * against the provider's own `isPublicRoute` rather than a reimplementation of its matching.
 */
describe("PUBLIC_ROUTES", () => {
  /** A route group — `(dashboard)` — wraps pages without contributing a URL segment. */
  const isRouteGroup = (name: string) => name.startsWith("(") && name.endsWith(")");
  /** `[id]` / `[...slug]`. Matching is prefix-based, so the static ancestor is what must be listed. */
  const isDynamic = (name: string) => name.startsWith("[");
  /** The one authenticated group. A route inside it needs a session by design. */
  const AUTHENTICATED_GROUP = "(dashboard)";

  /** Every URL `app/` actually serves, paired with whether it sits inside the authenticated group. */
  function appRoutes(): Array<{ url: string; authenticated: boolean }> {
    const found: Array<{ url: string; authenticated: boolean }> = [];

    const walk = (dir: string, segments: string[], authenticated: boolean) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(e.name))) {
        found.push({ url: `/${segments.join("/")}`.replace(/\/+$/, "") || "/", authenticated });
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (isRouteGroup(entry.name)) {
          // Contributes no URL segment — but `(dashboard)` marks everything beneath it as authenticated.
          walk(join(dir, entry.name), segments, authenticated || entry.name === AUTHENTICATED_GROUP);
          continue;
        }
        // A dynamic segment is covered by its static ancestor, since matching is prefix-based.
        if (isDynamic(entry.name)) continue;
        walk(join(dir, entry.name), [...segments, entry.name], authenticated);
      }
    };

    walk(join(process.cwd(), "app"), [], false);
    return found;
  }

  it("covers every route app/ serves outside the authenticated group", () => {
    const routes = appRoutes();
    // The walk is only meaningful if it resolved real URLs — including one inside a route group, which
    // is the case that a directory-name scan gets wrong.
    expect(routes.map((r) => r.url)).toEqual(expect.arrayContaining(["/", "/api-docs", "/sandbox", "/login"]));
    expect(routes.filter((r) => r.authenticated).length).toBeGreaterThan(0);
    expect(routes.some((r) => r.url.includes("("))).toBe(false);

    for (const { url, authenticated } of routes) {
      if (authenticated || url === "/login") continue;
      expect(isPublicRoute(url), `app serves ${url} outside ${AUTHENTICATED_GROUP} but it is not public`)
        .toBe(true);
    }
  });

  it("keeps the authenticated group gated", () => {
    // The converse: the allowlist must not accidentally open the dashboard. `/` covering everything
    // by prefix would satisfy the test above while unlocking the whole app.
    for (const { url, authenticated } of appRoutes()) {
      if (!authenticated) continue;
      expect(isPublicRoute(url), `${url} is inside ${AUTHENTICATED_GROUP} but PUBLIC_ROUTES exempts it`)
        .toBe(false);
    }
  });

  it("does not redirect any route it lists", async () => {
    for (const route of PUBLIC_ROUTES) {
      mockReplace.mockClear();
      mockPathname.mockReturnValue(route);
      renderProvider();
      await new Promise((r) => setTimeout(r, 20));
      expect(mockReplace, `${route} is listed as public but redirected`).not.toHaveBeenCalled();
    }
  });
});
