/**
 * CORS tests (#105) — preflight + response decoration for the cross-site frontend.
 *   node --import tsx --test src/config/cors.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAllowedOrigins, preflightResponse, withCors } from "./cors.ts";

const ALLOWED = ["https://twh.os.mieweb.org"];
const reqFrom = (origin?: string, extra: Record<string, string> = {}) =>
  new Request("http://api/api/auth/login", { method: "OPTIONS", headers: { ...(origin ? { origin } : {}), ...extra } });

test("parseAllowedOrigins splits/trims and defaults to localhost dev origins", () => {
  assert.deepEqual(parseAllowedOrigins("https://a.dev, https://b.dev "), ["https://a.dev", "https://b.dev"]);
  assert.deepEqual(parseAllowedOrigins(undefined), ["http://localhost:3000", "http://127.0.0.1:3000"]);
});

test("preflight from an allowed origin echoes the origin + credentials + methods + requested headers", () => {
  const res = preflightResponse(reqFrom("https://twh.os.mieweb.org", { "access-control-request-headers": "authorization, content-type" }), ALLOWED);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://twh.os.mieweb.org");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.equal(res.headers.get("access-control-allow-headers"), "authorization, content-type");
});

test("preflight from a disallowed origin returns 204 WITHOUT an allow-origin header", () => {
  const res = preflightResponse(reqFrom("https://evil.example"), ALLOWED);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("withCors decorates a real response for an allowed origin and leaves others untouched", async () => {
  const base = () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  const allowed = withCors(base(), new Request("http://api/x", { headers: { origin: "https://twh.os.mieweb.org" } }), ALLOWED);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://twh.os.mieweb.org");
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  assert.equal(await allowed.text(), "ok");

  const untouched = withCors(base(), new Request("http://api/x", { headers: { origin: "https://evil.example" } }), ALLOWED);
  assert.equal(untouched.headers.get("access-control-allow-origin"), null);
});
