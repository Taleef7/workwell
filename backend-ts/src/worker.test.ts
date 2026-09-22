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
import { inFlightRequests } from "./admin/runtime-health.ts";

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

test("#663/#625: health and version say which build is answering, since when, and whether the loop stalled", async () => {
  const health = (await (await call("/health")).json()) as Record<string, unknown> & {
    build: { sha: string | null };
    startedAt: string;
    uptimeSeconds: number;
    eventLoop: { stallsSinceStart: number; thresholdMs: number };
  };
  assert.equal(health.status, "UP");
  assert.equal(health.stack, "workwell-ts", "the original two fields are unchanged");
  assert.ok("sha" in health.build);
  assert.ok(!Number.isNaN(Date.parse(health.startedAt)));
  assert.equal(typeof health.uptimeSeconds, "number");
  assert.equal(typeof health.eventLoop.stallsSinceStart, "number");

  const version = (await (await call("/api/version")).json()) as Record<string, unknown>;
  assert.equal(version.build, "workwell-api-ts", "unchanged for existing readers");
  assert.ok("sha" in version && "startedAt" in version);
});

test("#663: a request stays in flight until its BODY is read — a streaming export is attributed while it streams", async () => {
  const count = () => inFlightRequests().filter((r) => r.path === "/api/version").length;
  const before = count();
  const res = await call("/api/version");
  assert.equal(count(), before + 1, "handler returned, body unread: still in flight");
  await res.text();
  assert.equal(count(), before, "settled once the body was consumed");
});

test("#663: a client that disconnects before reading the body does not leave the request 'in flight' forever", async () => {
  const count = () => inFlightRequests().filter((r) => r.path === "/api/version").length;
  const before = count();
  const client = new AbortController();
  const res = await worker.fetch(new Request("http://x/api/version", { signal: client.signal }), env, ctx);
  assert.equal(count(), before + 1);
  client.abort(); // the host never reads or cancels this body once the socket is gone
  assert.equal(count(), before, "settled on disconnect");
  void res;
});

test("#663: a request whose client was ALREADY gone when it arrived is not left in flight", async () => {
  const count = () => inFlightRequests().filter((r) => r.path === "/api/version").length;
  const before = count();
  const client = new AbortController();
  client.abort(); // an aborted signal never fires its listener again
  await worker.fetch(new Request("http://x/api/version", { signal: client.signal }), env, ctx);
  assert.equal(count(), before);
});

test("#663: /api/admin/runtime is ADMIN-only — the paths stay off the public route", async () => {
  assert.equal((await call("/api/admin/runtime")).status, 401);
});

test("#663: health polls are not registered — they are never a stall's cause and would crowd the report", async () => {
  const before = inFlightRequests().length;
  await call("/health"); // body deliberately unread
  assert.equal(inFlightRequests().length, before);
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

test("CDS Hooks: discovery is reachable with no token, invoking is not", async () => {
  // Through the REAL worker with auth ENABLED, because that is the only place the ordering of the auth
  // gate and the handler is exercised. `/cds-services` is outside `/api/`, where `authorize` ends in
  // permitAll — so an omitted rule would show up here as a 200 on the invoke path, not as a unit failure.
  const discovery = await call("/cds-services");
  assert.equal(discovery.status, 200);
  const { services } = (await discovery.json()) as { services: Array<{ hook: string; id: string }> };
  assert.equal(services.length, 1);
  assert.equal(services[0]!.hook, "patient-view");

  const invoke = await call(`/cds-services/${services[0]!.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook: "patient-view", hookInstance: "i", context: { patientId: "emp-006" } }),
  });
  assert.equal(invoke.status, 401, "invoking must require a token — it returns per-patient clinical status");
  assert.equal(
    (await call(`/cds-services/${services[0]!.id}/feedback`, { method: "POST", body: "{}" })).status,
    401,
  );
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
