/**
 * `WORKWELL_PUBLIC_API_URL` (#704): validated, and never replaced by the request's own origin while auth is on.
 *   node --import tsx --test src/config/public-api-url.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpResourceOf, publicApiUrl } from "./public-api-url.ts";

const req = new Request("http://internal:8080/mcp", { headers: { host: "attacker.example" } });

test("an https origin, or http on a loopback host, is accepted as it is", () => {
  for (const value of ["https://twh-api-ts.os.mieweb.org", "http://localhost:8787", "http://127.0.0.1:8787"]) {
    assert.deepEqual(publicApiUrl({ WORKWELL_PUBLIC_API_URL: value }, req, true), { ok: true, origin: value });
  }
  assert.equal(mcpResourceOf("https://twh-api-ts.os.mieweb.org"), "https://twh-api-ts.os.mieweb.org/mcp");
});

test("anything but a bare origin is refused: a path, a trailing slash, plain http elsewhere, garbage", () => {
  for (const value of ["https://api.test/", "https://api.test/mcp", "https://api.test?x=1", "http://api.test", "ftp://api.test", "not a url"]) {
    assert.equal(publicApiUrl({ WORKWELL_PUBLIC_API_URL: value }, req, true).ok, false, value);
  }
});

test("unset: refused while auth is enabled (no Host-derived audience), the request origin only with auth off", () => {
  assert.equal(publicApiUrl({}, req, true).ok, false);
  assert.deepEqual(publicApiUrl({}, req, false), { ok: true, origin: "http://internal:8080" });
});
