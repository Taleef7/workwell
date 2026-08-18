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
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { act, render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { server } from "../../test/msw/server";
import { AuthProvider, PUBLIC_ROUTES, isPublicRoute, useAuth } from "../auth-provider";

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
