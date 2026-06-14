/**
 * Worker integration test (#105): the auth gate protects real routes end-to-end
 * through the default fetch — public health, 401 without a token, login → token →
 * authorized access, role-gated 403. A SQLite floor DB backs the store-backed routes
 * (e.g. /api/measures).
 *   node --import tsx --test src/worker.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import worker from "./worker.ts";
import type { Env } from "./worker.ts";

const dbPath = join(tmpdir(), `workwell-worker-${crypto.randomUUID()}.sqlite`);
const env = { WORKWELL_AUTH_JWT_SECRET: "x".repeat(40) } as unknown as Env;
before(async () => {
  (env as unknown as { DB: unknown }).DB = await createSqliteD1(dbPath);
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});
const ctx = {} as never;
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`http://x${path}`, init), env, ctx);

test("health is public", async () => {
  assert.equal((await call("/actuator/health")).status, 200);
});

test("CORS preflight on login is answered (204 + allow-origin) before auth", async () => {
  const res = await call("/api/auth/login", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:3000", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("an actual cross-site response carries the allow-origin header", async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@workwell.dev", password: "Workwell123!" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("a protected route without a token is 401", async () => {
  assert.equal((await call("/api/runs")).status, 401);
});

test("login → token → authorized access, and role gates return 403", async () => {
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cm@workwell.dev", password: "Workwell123!" }),
  });
  assert.equal(login.status, 200);
  const { token, role } = (await login.json()) as { token: string; role: string };
  assert.equal(role, "ROLE_CASE_MANAGER");

  const auth = { authorization: `Bearer ${token}` };

  // authenticated read is allowed
  assert.equal((await call("/api/measures", { headers: auth })).status, 200);

  // the ELM Explorer compile is allowed for any authenticated user
  const compile = await call("/api/measures/compile", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ cql: "library D version '1.0.0'\nusing FHIR version '4.0.1'\ncontext Patient\ndefine \"X\": 1" }),
  });
  assert.equal(compile.status, 200);

  // admin-only route is forbidden for a case manager
  assert.equal((await call("/api/admin/integrations", { headers: auth })).status, 403);
});
