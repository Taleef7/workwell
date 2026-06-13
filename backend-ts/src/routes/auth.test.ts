/**
 * Auth route tests (#105): login → access token + refresh cookie; refresh rotates;
 * bad creds / missing cookie → 401; logout clears the cookie. No JVM, no DB.
 *   node --import tsx --test src/routes/auth.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthHandler } from "./auth.ts";
import { createJwt } from "../auth/jwt.ts";

const SECRET = "auth-route-test-secret";
const handle = createAuthHandler({ secret: SECRET, cookieSameSite: "None", cookieSecure: true });
const jwt = createJwt({ secret: SECRET });

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  handle(new Request(`http://x${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));

test("login with valid demo credentials returns a token + role and sets the refresh cookie", async () => {
  const res = await post("/api/auth/login", { email: "admin@workwell.dev", password: "Workwell123!" });
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { token: string; email: string; role: string };
  assert.equal(body.email, "admin@workwell.dev");
  assert.equal(body.role, "ROLE_ADMIN");
  assert.deepEqual(jwt.verifyAccessToken(body.token), { email: "admin@workwell.dev", role: "ROLE_ADMIN" });
  const cookie = res!.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^refresh_token=.+/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/api\/auth/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
});

test("login is case-insensitive on email and maps each demo user to its role", async () => {
  const res = await post("/api/auth/login", { email: "CM@Workwell.dev", password: "Workwell123!" });
  assert.equal(res?.status, 200);
  assert.equal(((await res!.json()) as { role: string }).role, "ROLE_CASE_MANAGER");
});

test("login with a wrong password → 401", async () => {
  const res = await post("/api/auth/login", { email: "admin@workwell.dev", password: "nope" });
  assert.equal(res?.status, 401);
});

test("login with an unknown user → 401", async () => {
  const res = await post("/api/auth/login", { email: "ghost@workwell.dev", password: "Workwell123!" });
  assert.equal(res?.status, 401);
});

test("refresh reads the cookie, returns a fresh access token, and rotates the cookie", async () => {
  const login = await post("/api/auth/login", { email: "author@workwell.dev", password: "Workwell123!" });
  const setCookie = login!.headers.get("set-cookie")!;
  const refreshToken = setCookie.split(";")[0]!.split("=")[1]!;

  const res = await post("/api/auth/refresh", undefined, { cookie: `refresh_token=${refreshToken}` });
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { token: string; role: string };
  assert.equal(body.role, "ROLE_AUTHOR");
  assert.deepEqual(jwt.verifyAccessToken(body.token), { email: "author@workwell.dev", role: "ROLE_AUTHOR" });
  assert.match(res!.headers.get("set-cookie") ?? "", /^refresh_token=.+HttpOnly/s);
});

test("refresh without a cookie → 401", async () => {
  const res = await post("/api/auth/refresh");
  assert.equal(res?.status, 401);
});

test("an access token presented as a refresh cookie is rejected → 401", async () => {
  const access = jwt.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  const res = await post("/api/auth/refresh", undefined, { cookie: `refresh_token=${access}` });
  assert.equal(res?.status, 401);
});

test("logout clears the refresh cookie (Max-Age=0)", async () => {
  const res = await post("/api/auth/logout");
  assert.equal(res?.status, 204);
  assert.match(res!.headers.get("set-cookie") ?? "", /refresh_token=;.*Max-Age=0/);
});
