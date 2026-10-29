/**
 * Redirect URI registration and matching, and PKCE (MCP OAuth).
 *   node --import tsx --test src/auth/oauth/redirect-uris.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { redirectMatches, redirectOrigin, redirectProblem } from "./redirect-uris.ts";
import { isCodeVerifier, isS256Challenge, s256, verifierMatches } from "./pkce.ts";

test("a self-registered client may only use loopback http; a verified (CIMD) client may also use https", () => {
  for (const uri of ["http://localhost:3334/oauth/callback", "http://127.0.0.1/callback", "http://[::1]:9000/cb"]) {
    assert.equal(redirectProblem(uri, "dcr"), null, uri);
    assert.equal(redirectProblem(uri, "cimd"), null, uri);
  }
  assert.match(redirectProblem("https://claude.ai/api/mcp/auth_callback", "dcr")!, /loopback/);
  assert.equal(redirectProblem("https://claude.ai/api/mcp/auth_callback", "cimd"), null);
  for (const uri of ["http://evil.example/cb", "http://localhost.evil.example/cb", "javascript:alert(1)", "cursor://cb", "http://localhost/cb#frag", "https://u:p@claude.ai/cb", "not a url"]) {
    assert.notEqual(redirectProblem(uri, "cimd"), null, uri);
  }
});

test("a requested redirect matches exactly, or on loopback http with any port and nothing else changed", () => {
  const registered = ["http://localhost/callback", "http://127.0.0.1/callback", "https://claude.ai/api/mcp/auth_callback"];
  assert.equal(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectMatches(registered, "http://localhost:51234/callback"), true, "port ignored on loopback");
  assert.equal(redirectMatches(registered, "http://127.0.0.1:8080/callback"), true);
  assert.equal(redirectMatches(registered, "https://claude.ai:8443/api/mcp/auth_callback"), false, "never on https");
  assert.equal(redirectMatches(registered, "http://localhost:51234/callback/extra"), false, "the path must match");
  assert.equal(redirectMatches(registered, "http://localhost:51234/callback?x=1"), false, "the query must match");
  assert.equal(redirectMatches(registered, "http://[::1]:5000/callback"), false, "another loopback host is another URI");
  assert.equal(redirectMatches(registered, "http://localhost:51234/callback#f"), false);
  assert.equal(redirectOrigin("http://localhost:51234/callback"), "http://localhost:51234");
});

test("PKCE: S256 of a valid verifier, compared in constant time", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(s256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636 appendix B");
  assert.equal(verifierMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), true);
  assert.equal(verifierMatches(`${verifier}x`, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), false);
  assert.equal(isCodeVerifier("short"), false);
  assert.equal(isCodeVerifier("a".repeat(129)), false);
  assert.equal(isCodeVerifier(`${"a".repeat(42)}!`), false);
  assert.equal(isS256Challenge(verifier), true);
  assert.equal(isS256Challenge("plain-challenge"), false);
});
