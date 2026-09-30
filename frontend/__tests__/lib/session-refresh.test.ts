import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { __setRefreshRetryDelaysForTest, cancelSessionRefresh, refreshSession } from "@/lib/api/session-refresh";

/**
 * Only a refresh the server REFUSED ends the session. One it could not answer is retried: signing the
 * user out there turned every deploy into a logout.
 */
beforeEach(() => {
  __setRefreshRetryDelaysForTest([5, 5, 5]);
});
afterEach(() => {
  __setRefreshRetryDelaysForTest(null);
  vi.unstubAllGlobals();
});

function refreshAnswers(...answers: Array<() => Response>) {
  let calls = 0;
  server.use(
    http.post("*/api/auth/refresh", () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls++;
      return answer();
    }),
  );
  return () => calls;
}

const ok = () => HttpResponse.json({ token: "fresh", email: "a@b.dev", role: "ROLE_ADMIN" });

describe("refreshSession", () => {
  it("a 401 is a refusal, asked once", async () => {
    const calls = refreshAnswers(() => HttpResponse.json({ error: "invalid_refresh_token" }, { status: 401 }));
    expect(await refreshSession()).toEqual({ kind: "refused" });
    expect(calls()).toBe(1);
  });

  it.each([
    ["a network error", () => HttpResponse.error()],
    ["a 502 from the proxy", () => new HttpResponse("Bad Gateway", { status: 502 })],
    ["a 503 while the pool is busy", () => HttpResponse.json({ error: "pool_exhausted" }, { status: 503 })],
    ["a 504 from the proxy", () => new HttpResponse(null, { status: 504 })],
    ["a 429", () => new HttpResponse(null, { status: 429 })],
    // The refresh route refuses only with 401; any other 4xx came from something in front of it.
    ["a 404 while the container is replaced", () => new HttpResponse(null, { status: 404 })],
    ["a 403 from the proxy", () => new HttpResponse(null, { status: 403 })],
  ])("%s is retried until the server answers", async (_name, outage) => {
    const calls = refreshAnswers(outage, outage, ok);
    expect(await refreshSession()).toEqual({ kind: "ok", token: "fresh", email: "a@b.dev", role: "ROLE_ADMIN" });
    expect(calls()).toBe(3);
  });

  it("gives up as unavailable, not refused, once the retries are spent", async () => {
    const calls = refreshAnswers(() => new HttpResponse(null, { status: 502 }));
    expect(await refreshSession()).toEqual({ kind: "unavailable" });
    expect(calls()).toBe(4); // the first attempt and three retries
  });

  it("a 2xx without a token is a refusal: asking again would get the same answer", async () => {
    const calls = refreshAnswers(() => HttpResponse.json({}));
    expect(await refreshSession()).toEqual({ kind: "refused" });
    expect(calls()).toBe(1);
  });

  it("takes the cross-tab lock once per attempt, never across the wait between them", async () => {
    // One lock held over the whole retry would keep every other tab waiting out the outage too.
    const requests: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async (name: string, cb: () => Promise<unknown>) => {
          requests.push(name);
          return cb();
        },
      },
    });
    const calls = refreshAnswers(() => HttpResponse.error(), () => HttpResponse.error(), ok);
    expect((await refreshSession()).kind).toBe("ok");
    expect(calls()).toBe(3);
    expect(requests).toEqual(["workwell-auth-refresh", "workwell-auth-refresh", "workwell-auth-refresh"]);
  });

  it("a cancelled refresh (a logout or a new login) stops asking, and never answers `refused`", async () => {
    __setRefreshRetryDelaysForTest([20, 20, 20]);
    const calls = refreshAnswers(() => HttpResponse.error());
    const pending = refreshSession();
    await new Promise((r) => setTimeout(r, 5));
    cancelSessionRefresh();
    expect(await pending).toEqual({ kind: "unavailable" });
    expect(calls()).toBe(1);
  });

  it.each([
    ["a token", () => HttpResponse.json({ token: "old-login", email: "a@b.dev", role: "ROLE_ADMIN" })],
    ["a refusal", () => HttpResponse.json({ error: "invalid_refresh_token" }, { status: 401 })],
  ])("an attempt in flight when the session ends has its answer (%s) dropped", async (_name, answer) => {
    // No retries: the in-flight attempt is the last one, which is where the check was once missing.
    __setRefreshRetryDelaysForTest([]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    server.use(
      http.post("*/api/auth/refresh", async () => {
        await gate;
        return answer();
      }),
    );
    const pending = refreshSession();
    await new Promise((r) => setTimeout(r, 5));
    cancelSessionRefresh(); // a logout, or a login as someone else, while the request is out
    release();
    expect(await pending).toEqual({ kind: "unavailable" });
  });

  it("concurrent callers share one refresh, since each refresh rotates the cookie", async () => {
    const calls = refreshAnswers(() => HttpResponse.error(), ok);
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("ok");
    expect(calls()).toBe(2);
  });
});
