import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { ApiClient } from "@/lib/api/client";

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
