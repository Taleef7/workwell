/**
 * Authorization matrix tests (#105) — the ported SecurityConfig role gates.
 *   node --import tsx --test src/auth/authorize.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, extractPrincipal } from "./authorize.ts";
import { createJwt } from "./jwt.ts";

const p = (role: string) => ({ email: "u@workwell.dev", role });
const admin = p("ROLE_ADMIN");
const author = p("ROLE_AUTHOR");
const approver = p("ROLE_APPROVER");
const cm = p("ROLE_CASE_MANAGER");

test("public routes are permitted without a principal", () => {
  for (const path of ["/api/auth/login", "/api/auth/refresh", "/actuator/health", "/api/version", "/health"]) {
    assert.equal(authorize("POST", path, null).ok, true, path);
  }
});

test("a protected GET with no principal is 401", () => {
  assert.deepEqual(authorize("GET", "/api/runs", null), { ok: false, status: 401 });
});

test("authenticated-but-wrong-role is 403, right role is allowed", () => {
  // /api/admin/** requires ADMIN
  assert.deepEqual(authorize("GET", "/api/admin/integrations", author), { ok: false, status: 403 });
  assert.equal(authorize("GET", "/api/admin/integrations", admin).ok, true);
});

test("measure authoring gates: AUTHOR or ADMIN may PUT spec; APPROVER may not", () => {
  assert.equal(authorize("PUT", "/api/measures/abc/spec", author).ok, true);
  assert.equal(authorize("PUT", "/api/measures/abc/spec", admin).ok, true);
  assert.deepEqual(authorize("PUT", "/api/measures/abc/spec", approver), { ok: false, status: 403 });
});

test("approve/activate require APPROVER or ADMIN; deprecate is ADMIN-only", () => {
  assert.equal(authorize("POST", "/api/measures/abc/approve", approver).ok, true);
  assert.deepEqual(authorize("POST", "/api/measures/abc/approve", author), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/measures/abc/deprecate", approver), { ok: false, status: 403 });
  assert.equal(authorize("POST", "/api/measures/abc/deprecate", admin).ok, true);
});

test("runs/cases writes require CASE_MANAGER or ADMIN", () => {
  assert.equal(authorize("POST", "/api/runs/manual", cm).ok, true);
  assert.deepEqual(authorize("POST", "/api/runs/manual", author), { ok: false, status: 403 });
});

test("the ELM Explorer endpoints are gated to any authenticated user", () => {
  assert.deepEqual(authorize("POST", "/api/measures/compile", null), { ok: false, status: 401 });
  assert.equal(authorize("POST", "/api/measures/compile", author).ok, true);
  assert.equal(authorize("POST", "/api/measures/compile", cm).ok, true); // not author-gated
  assert.equal(authorize("GET", "/api/measures/audiogram/elm", cm).ok, true);
});

test("non-/api routes default to permit", () => {
  assert.equal(authorize("GET", "/", null).ok, true);
});

test("extractPrincipal reads a Bearer access token and ignores refresh/garbage", () => {
  const jwt = createJwt({ secret: "authorize-test-secret" });
  const access = jwt.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  const req = new Request("http://x/api/runs", { headers: { authorization: `Bearer ${access}` } });
  assert.deepEqual(extractPrincipal(req, jwt), { email: "admin@workwell.dev", role: "ROLE_ADMIN" });

  const refresh = jwt.issueRefreshToken("admin@workwell.dev");
  const refreshReq = new Request("http://x/api/runs", { headers: { authorization: `Bearer ${refresh}` } });
  assert.equal(extractPrincipal(refreshReq, jwt), null);
  assert.equal(extractPrincipal(new Request("http://x/api/runs"), jwt), null);
});
