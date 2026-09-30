import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { ApiClient, SERVER_UNAVAILABLE_MESSAGE } from "@/lib/api/client";
import { __setRefreshRetryDelaysForTest } from "@/lib/api/session-refresh";

describe("ApiClient", () => {
  it("sends Authorization header when token is provided", async () => {
    let capturedHeader: string | null = null;

    server.use(
      http.get("*/api/test-auth", ({ request }) => {
        capturedHeader = request.headers.get("Authorization");
        return HttpResponse.json({ ok: true });
      })
    );

    const client = new ApiClient({ token: "test-token-123" });
    await client.get("/api/test-auth");

    expect(capturedHeader).toBe("Bearer test-token-123");
  });

  it("calls onUnauthorized when server returns 401", async () => {
    server.use(
      http.get("*/api/protected", () => HttpResponse.json({ error: "unauthorized" }, { status: 401 }))
    );

    const onUnauthorized = vi.fn();
    // Prevent the token refresh attempt from making a real call
    server.use(
      http.post("*/api/auth/refresh", () => HttpResponse.json({}, { status: 401 }))
    );

    const client = new ApiClient({ token: null, onUnauthorized });

    await expect(client.get("/api/protected")).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("keeps the session when the refresh cannot reach the server: a retryable 503, never onUnauthorized", async () => {
    __setRefreshRetryDelaysForTest([5, 5]);
    try {
      let refreshes = 0;
      server.use(
        http.get("*/api/protected-outage", () => HttpResponse.json({ error: "expired" }, { status: 401 })),
        http.post("*/api/auth/refresh", () => {
          refreshes++;
          return new HttpResponse("Bad Gateway", { status: 502 });
        })
      );
      const onUnauthorized = vi.fn();
      const client = new ApiClient({ token: "expired-token", onUnauthorized });

      await expect(client.get("/api/protected-outage")).rejects.toMatchObject({ status: 503, message: SERVER_UNAVAILABLE_MESSAGE });
      expect(refreshes).toBe(3); // the first attempt and both retries
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      __setRefreshRetryDelaysForTest(null);
    }
  });

  it("rides out a restart: the refresh is retried and the request then succeeds", async () => {
    __setRefreshRetryDelaysForTest([5, 5, 5]);
    try {
      let calls = 0;
      let refreshes = 0;
      server.use(
        http.get("*/api/protected-restart", () => {
          calls++;
          return calls === 1 ? HttpResponse.json({ error: "expired" }, { status: 401 }) : HttpResponse.json({ ok: true });
        }),
        http.post("*/api/auth/refresh", () => {
          refreshes++;
          return refreshes < 3 ? HttpResponse.error() : HttpResponse.json({ token: "fresh-token" });
        })
      );
      const onUnauthorized = vi.fn();
      const onTokenRefreshed = vi.fn();
      const client = new ApiClient({ token: "expired-token", onUnauthorized, onTokenRefreshed });

      await expect(client.get("/api/protected-restart")).resolves.toEqual({ ok: true });
      expect(onTokenRefreshed).toHaveBeenCalledWith("fresh-token");
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      __setRefreshRetryDelaysForTest(null);
    }
  });

  it("throws ApiError on non-ok responses", async () => {
    server.use(
      http.get("*/api/not-found", () => HttpResponse.json({ message: "Not found" }, { status: 404 }))
    );

    const client = new ApiClient({ token: null });
    await expect(client.get("/api/not-found")).rejects.toMatchObject({ status: 404 });
  });

  it("POST sends JSON body and Content-Type header", async () => {
    let capturedBody: unknown = null;
    let capturedContentType: string | null = null;

    server.use(
      http.post("*/api/data", async ({ request }) => {
        capturedBody = await request.json();
        capturedContentType = request.headers.get("Content-Type");
        return HttpResponse.json({ saved: true });
      })
    );

    const client = new ApiClient({ token: "tok" });
    await client.post("/api/data", { key: "value" });

    expect(capturedBody).toEqual({ key: "value" });
    expect(capturedContentType).toContain("application/json");
  });
});
