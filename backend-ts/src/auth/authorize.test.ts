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
const viewer = p("ROLE_VIEWER");

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

test("the runs COLLECTION create (POST /api/runs, no trailing slash) is also CM/ADMIN-gated", () => {
  // regression: /api/runs/** must match the base path too (Spring AntPathMatcher),
  // else POST /api/runs falls through to the generic authenticated /api/** rule.
  assert.equal(authorize("POST", "/api/runs", cm).ok, true);
  assert.equal(authorize("POST", "/api/runs", admin).ok, true);
  assert.deepEqual(authorize("POST", "/api/runs", author), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/runs", approver), { ok: false, status: 403 });
  // and the same for cases + the admin base
  assert.deepEqual(authorize("POST", "/api/cases", author), { ok: false, status: 403 });
  assert.deepEqual(authorize("GET", "/api/admin", author), { ok: false, status: 403 });
});

test("batch outreach campaigns require CASE_MANAGER or ADMIN (all methods), not the AUTHENTICATED /api/** fallback", () => {
  // POST /api/campaigns is a batch outreach mutation over up to 100k cases — it must match
  // per-case outreach (CM/ADMIN), not fall through to the generic authenticated /api/** rule.
  assert.equal(authorize("POST", "/api/campaigns", cm).ok, true);
  assert.equal(authorize("POST", "/api/campaigns", admin).ok, true);
  assert.deepEqual(authorize("POST", "/api/campaigns", author), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/campaigns", approver), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/campaigns", null), { ok: false, status: 401 });
  // GET (list + by-id) is operational case/PII data — also CM/ADMIN, denied for AUTHOR
  assert.equal(authorize("GET", "/api/campaigns", cm).ok, true);
  assert.equal(authorize("GET", "/api/campaigns/abc", admin).ok, true);
  assert.deepEqual(authorize("GET", "/api/campaigns", author), { ok: false, status: 403 });
  assert.deepEqual(authorize("GET", "/api/campaigns/abc", approver), { ok: false, status: 403 });
});

test("order proposals require CASE_MANAGER or ADMIN (all methods), not the AUTHENTICATED /api/** fallback", () => {
  // GET /api/orders/proposals is clinical decision support over at-risk case/PII data —
  // must match [CM, A] before the generic AUTHENTICATED /api/** fallback (#77 E7).
  assert.equal(authorize("GET", "/api/orders/proposals", cm).ok, true);
  assert.equal(authorize("GET", "/api/orders/proposals", admin).ok, true);
  assert.deepEqual(authorize("GET", "/api/orders/proposals", author), { ok: false, status: 403 });
  assert.deepEqual(authorize("GET", "/api/orders/proposals", approver), { ok: false, status: 403 });
  assert.deepEqual(authorize("GET", "/api/orders/proposals", null), { ok: false, status: 401 });
  // All other methods on /api/orders/** are also gated (mirroring campaigns AnyMethod rule)
  assert.equal(authorize("POST", "/api/orders/anything", cm).ok, true);
  assert.deepEqual(authorize("POST", "/api/orders/anything", author), { ok: false, status: 403 });
});

test("segments: writes are ADMIN-only; reads fall through to AUTHENTICATED (#183 E11.3)", () => {
  // Writes (POST/PUT/DELETE) are ADMIN-only — must match before the AUTHENTICATED /api/** fallback.
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    assert.equal(authorize(method, "/api/segments", admin).ok, true, method);
    assert.deepEqual(authorize(method, "/api/segments/abc", cm), { ok: false, status: 403 }, method);
    assert.deepEqual(authorize(method, "/api/segments/abc", author), { ok: false, status: 403 }, method);
    assert.deepEqual(authorize(method, "/api/segments", null), { ok: false, status: 401 }, method);
  }
  // Reads (list + preview) are AUTHENTICATED for any role.
  assert.equal(authorize("GET", "/api/segments", cm).ok, true);
  assert.equal(authorize("GET", "/api/segments/abc/preview", author).ok, true);
  assert.deepEqual(authorize("GET", "/api/segments", null), { ok: false, status: 401 });
  // POST /api/segments/preview (the editor's dry-run) is a write-method path → ADMIN-only via /api/segments/**.
  assert.equal(authorize("POST", "/api/segments/preview", admin).ok, true);
  assert.deepEqual(authorize("POST", "/api/segments/preview", cm), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/segments/preview", null), { ok: false, status: 401 });
});

test("auditor packets: run packets are CM/ADMIN, measure-version packets are APPROVER/ADMIN", () => {
  // run packets — CASE_MANAGER or ADMIN (operational), not AUTHOR/APPROVER
  assert.equal(authorize("GET", "/api/auditor/runs/abc/packet", cm).ok, true);
  assert.equal(authorize("GET", "/api/auditor/runs/abc/packet", admin).ok, true);
  assert.deepEqual(authorize("GET", "/api/auditor/runs/abc/packet", approver), { ok: false, status: 403 });
  assert.deepEqual(authorize("GET", "/api/auditor/runs/abc/packet", null), { ok: false, status: 401 });
  // measure-version packets — APPROVER or ADMIN (authoring/governance), not CASE_MANAGER
  assert.equal(authorize("GET", "/api/auditor/measure-versions/v1/packet", approver).ok, true);
  assert.equal(authorize("GET", "/api/auditor/measure-versions/v1/packet", admin).ok, true);
  assert.deepEqual(authorize("GET", "/api/auditor/measure-versions/v1/packet", cm), { ok: false, status: 403 });
});

test("the ELM Explorer endpoints are gated to any authenticated user", () => {
  assert.deepEqual(authorize("POST", "/api/measures/compile", null), { ok: false, status: 401 });
  assert.equal(authorize("POST", "/api/measures/compile", author).ok, true);
  assert.equal(authorize("POST", "/api/measures/compile", cm).ok, true); // not author-gated
  assert.equal(authorize("GET", "/api/measures/audiogram/elm", cm).ok, true);
});

test("read-only viewer (public sandbox) may GET anything authenticated but never write", () => {
  // reads across the surfaces the sandbox browses succeed (AUTHENTICATED /api/** fallback)
  assert.equal(authorize("GET", "/api/runs", viewer).ok, true);
  assert.equal(authorize("GET", "/api/compliance/roster", viewer).ok, true);
  assert.equal(authorize("GET", "/api/measures/abc", viewer).ok, true);
  // every write is 403 — including AUTHENTICATED-fallback writes other roles CAN do (e.g. compile)
  assert.deepEqual(authorize("POST", "/api/measures/compile", viewer), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/runs/manual", viewer), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/cases/abc/actions/outreach", viewer), { ok: false, status: 403 });
  assert.deepEqual(authorize("PUT", "/api/measures/abc/spec", viewer), { ok: false, status: 403 });
  assert.deepEqual(authorize("DELETE", "/api/segments/abc", viewer), { ok: false, status: 403 });
  // role-restricted GETs the viewer isn't on still 403 (admin/evidence/packets)
  assert.deepEqual(authorize("GET", "/api/admin/integrations", viewer), { ok: false, status: 403 });
  // logout is PERMIT, so a viewer session can still sign out
  assert.equal(authorize("POST", "/api/auth/logout", viewer).ok, true);
});

test("non-/api routes default to permit", () => {
  assert.equal(authorize("GET", "/", null).ok, true);
});

test("Fable M4: AI write endpoints (bare + measure-scoped) are AUTHOR/ADMIN, not any authenticated role", () => {
  assert.equal(authorize("POST", "/api/ai/draft-spec", author).ok, true);
  assert.equal(authorize("POST", "/api/ai/draft-spec", admin).ok, true);
  // The bare alias previously fell through to the AUTHENTICATED /api/** fallback → billed-OpenAI abuse.
  assert.deepEqual(authorize("POST", "/api/ai/draft-spec", cm), { ok: false, status: 403 });
  assert.deepEqual(authorize("POST", "/api/ai/draft-spec", approver), { ok: false, status: 403 });
  assert.equal(authorize("POST", "/api/measures/abc/ai/draft-spec", author).ok, true);
});

test("Fable M23: outreach templates are CM/ADMIN-readable but ADMIN-only to write", () => {
  assert.equal(authorize("GET", "/api/admin/outreach-templates", cm).ok, true);
  assert.equal(authorize("GET", "/api/admin/outreach-templates", admin).ok, true);
  assert.equal(authorize("GET", "/api/admin/outreach-templates/abc/preview", cm).ok, true);
  assert.deepEqual(authorize("GET", "/api/admin/outreach-templates", author), { ok: false, status: 403 });
  // writes stay ADMIN via /api/admin/**
  assert.deepEqual(authorize("POST", "/api/admin/outreach-templates", cm), { ok: false, status: 403 });
  // an unrelated admin GET is still ADMIN-only (the CM carve-out is scoped to templates)
  assert.deepEqual(authorize("GET", "/api/admin/integrations", cm), { ok: false, status: 403 });
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
