import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGIN_TIMEOUT_MS, SERVER_DID_NOT_RESPOND, signInWithCredentials } from "../demo-login";

const respond = (status: number, body: string, contentType = "application/json") =>
  vi.fn().mockResolvedValue(new Response(body, { status, headers: { "content-type": contentType } }));

afterEach(() => vi.unstubAllGlobals());

describe("signInWithCredentials — what the user is told (#663)", () => {
  it("a server that does not answer is said to be down, not 'Failed to fetch'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(signInWithCredentials("a@b.c", "pw")).rejects.toThrow(SERVER_DID_NOT_RESPOND);
  });

  it("a timeout is the same answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("signal timed out", "TimeoutError")));
    await expect(signInWithCredentials("a@b.c", "pw")).rejects.toThrow(SERVER_DID_NOT_RESPOND);
  });

  it("a gateway 502/504 with an HTML body is the server's problem, never 'Invalid email or password'", async () => {
    vi.stubGlobal("fetch", respond(504, "<html>Gateway Timeout</html>", "text/html"));
    const err = await signInWithCredentials("a@b.c", "pw").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/server is having trouble \(error 504\)/);
    expect((err as Error).message).not.toMatch(/password/i);
  });

  it("a real 401 is still a wrong password", async () => {
    vi.stubGlobal("fetch", respond(401, JSON.stringify({ error: "unauthorized" })));
    await expect(signInWithCredentials("a@b.c", "pw")).rejects.toThrow("Invalid email or password.");
  });

  it("a server-supplied message still wins", async () => {
    vi.stubGlobal("fetch", respond(503, JSON.stringify({ message: "No database connection was available in time. Try again shortly." })));
    await expect(signInWithCredentials("a@b.c", "pw")).rejects.toThrow(/No database connection/);
  });

  it("the request carries a 20-second timeout, so a frozen server cannot hold the button for a minute", async () => {
    // Asserting only that a signal exists would pass with a plain AbortController that never fires
    // (Gemini review, #675), so pin the timeout itself.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = respond(200, JSON.stringify({ token: "t", email: "a@b.c", role: "ROLE_ADMIN" }));
    vi.stubGlobal("fetch", fetchMock);
    await signInWithCredentials("a@b.c", "pw");
    expect(timeoutSpy).toHaveBeenCalledWith(LOGIN_TIMEOUT_MS);
    expect(LOGIN_TIMEOUT_MS).toBe(20_000);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(timeoutSpy.mock.results[0]!.value);
    timeoutSpy.mockRestore();
  });
});
