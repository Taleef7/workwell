/**
 * Auth route tests (#105): login → access token + refresh cookie; refresh rotates;
 * bad creds / missing cookie → 401; logout clears the cookie. No JVM, no DB.
 *   node --import tsx --test src/routes/auth.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthHandler, type RefreshTokenRevocation } from "./auth.ts";
import { createJwt } from "../auth/jwt.ts";

const SECRET = "auth-route-test-secret";
const handle = createAuthHandler({ secret: SECRET, cookieSameSite: "None", cookieSecure: true });
const jwt = createJwt({ secret: SECRET });

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  handle(new Request(`http://x${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));

// ---- Fable M5: server-side refresh-token revocation ---------------------------------------------
/** In-memory revocation store mirroring the KV adapter (currentJti/rotate/revoke). */
function memRevocation() {
  const map = new Map<string, string>();
  const revoked: string[] = [];
  const store: RefreshTokenRevocation = {
    async currentJti(fam) {
      return map.get(fam) ?? null;
    },
    async rotate(fam, jti) {
      map.set(fam, jti);
    },
    async revoke(fam) {
      map.delete(fam);
      revoked.push(fam);
    },
  };
  return { store, map, revoked };
}

const cookieOf = (res: Response | null): string => res!.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;

test("M5: replaying a rotated-away refresh token is reuse → 401 and revokes the whole family", async () => {
  const rev = memRevocation();
  const h = createAuthHandler({ secret: SECRET, revocation: rev.store });
  const p = (path: string, cookie?: string) =>
    h(new Request(`http://x${path}`, { method: "POST", headers: cookie ? { cookie: `refresh_token=${cookie}` } : {}, body: path.endsWith("login") ? JSON.stringify({ email: "cm@workwell.dev", password: "Workwell123!" }) : undefined }));

  const login = await p("/api/auth/login");
  const token1 = cookieOf(login);
  // First refresh rotates → a new token; the family's current jti advances.
  const r1 = await p("/api/auth/refresh", token1);
  assert.equal(r1?.status, 200);
  const token2 = cookieOf(r1);
  assert.notEqual(token1, token2);
  // Replaying token1 (its jti was rotated away) is reuse → 401 + family revoked.
  const reuse = await p("/api/auth/refresh", token1);
  assert.equal(reuse?.status, 401);
  assert.equal(rev.revoked.length, 1);
  // Because the family was revoked, even the legitimately-rotated token2 is now dead.
  const after = await p("/api/auth/refresh", token2);
  assert.equal(after?.status, 401);
});

test("M5: logout revokes the family so the still-unexpired refresh token can't be reused", async () => {
  const rev = memRevocation();
  const h = createAuthHandler({ secret: SECRET, revocation: rev.store });
  const p = (path: string, cookie?: string) =>
    h(new Request(`http://x${path}`, { method: "POST", headers: cookie ? { cookie: `refresh_token=${cookie}` } : {}, body: path.endsWith("login") ? JSON.stringify({ email: "admin@workwell.dev", password: "Workwell123!" }) : undefined }));

  const token = cookieOf(await p("/api/auth/login"));
  assert.equal((await p("/api/auth/logout", token))?.status, 204);
  assert.equal(rev.revoked.length, 1);
  assert.equal((await p("/api/auth/refresh", token))?.status, 401);
});

test("M5: a rotation-WRITE failure at login issues an untracked token that still refreshes (no fail-closed)", async () => {
  // Codex P2: if the login rotate() write fails, the token must NOT carry a jti/fam (which would be
  // fail-closed on the next refresh via a null currentJti). It's issued untracked and upgraded later.
  let failNextRotate = true;
  const map = new Map<string, string>();
  const flaky: RefreshTokenRevocation = {
    async currentJti(fam) {
      return map.get(fam) ?? null;
    },
    async rotate(fam, jti) {
      if (failNextRotate) {
        failNextRotate = false;
        throw new Error("KV write failed");
      }
      map.set(fam, jti);
    },
    async revoke(fam) {
      map.delete(fam);
    },
  };
  const h = createAuthHandler({ secret: SECRET, revocation: flaky });
  const p = (path: string, cookie?: string) =>
    h(new Request(`http://x${path}`, { method: "POST", headers: cookie ? { cookie: `refresh_token=${cookie}` } : {}, body: path.endsWith("login") ? JSON.stringify({ email: "cm@workwell.dev", password: "Workwell123!" }) : undefined }));
  const token = cookieOf(await p("/api/auth/login")); // rotate() threw → untracked token
  // The untracked token refreshes (skips the revocation check) and now upgrades into a tracked family.
  const r = await p("/api/auth/refresh", token);
  assert.equal(r?.status, 200);
  // The upgraded token is now genuinely tracked (a further refresh still works).
  assert.equal((await p("/api/auth/refresh", cookieOf(r)))?.status, 200);
});

test("M5: a store outage (throwing revocation) degrades to stateless — refresh still works", async () => {
  const boom: RefreshTokenRevocation = {
    async currentJti() {
      throw new Error("KV down");
    },
    async rotate() {
      throw new Error("KV down");
    },
    async revoke() {
      throw new Error("KV down");
    },
  };
  const h = createAuthHandler({ secret: SECRET, revocation: boom });
  const p = (path: string, cookie?: string) =>
    h(new Request(`http://x${path}`, { method: "POST", headers: cookie ? { cookie: `refresh_token=${cookie}` } : {}, body: path.endsWith("login") ? JSON.stringify({ email: "cm@workwell.dev", password: "Workwell123!" }) : undefined }));
  const token = cookieOf(await p("/api/auth/login"));
  assert.equal((await p("/api/auth/refresh", token))?.status, 200);
});

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
