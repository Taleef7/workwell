import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { ApiClient } from "@/lib/api/client";
import { REFRESH_LOCK_NAME, withRefreshLock } from "@/lib/api/refresh-lock";

/**
 * A refresh rotates the login cookie and the server ends the login on a replayed one, so two tabs
 * refreshing at once signed everyone out. Every refresh must run inside the cross-tab lock.
 */
function fakeLocks() {
  const state = { held: false, names: [] as string[] };
  const locks = {
    request: vi.fn(async (name: string, cb: () => Promise<unknown>) => {
      state.names.push(name);
      state.held = true;
      try {
        return await cb();
      } finally {
        state.held = false;
      }
    }),
  };
  vi.stubGlobal("navigator", { ...navigator, locks });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the login refresh holds the cross-tab lock", () => {
  it("the per-request refresh talks to the server only while holding the lock", async () => {
    const lock = fakeLocks();
    let refreshedInsideLock: boolean | null = null;
    let calls = 0;
    server.use(
      http.get("*/api/protected-lock", () => {
        calls++;
        return calls === 1 ? HttpResponse.json({ error: "expired" }, { status: 401 }) : HttpResponse.json({ ok: true });
      }),
      http.post("*/api/auth/refresh", () => {
        refreshedInsideLock = lock.held;
        return HttpResponse.json({ token: "fresh-token" });
      }),
    );

    const client = new ApiClient({ token: "expired-token", onTokenRefreshed: vi.fn() });
    await expect(client.get("/api/protected-lock")).resolves.toEqual({ ok: true });

    expect(lock.names).toEqual([REFRESH_LOCK_NAME]);
    expect(refreshedInsideLock).toBe(true);
  });

  it("still refreshes where the browser has no Web Locks API", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: undefined });
    expect(await withRefreshLock(async () => "ran")).toBe("ran");
  });
});
