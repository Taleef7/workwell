/**
 * Tests for the TS JWT service (#105) — must preserve the Java JwtService contract
 * exactly so the unchanged frontend (and any Java token in flight during cutover)
 * interoperates: HS256, base64url no-pad, access `{sub,role,iat,exp}`, refresh
 * `{sub,refresh:true,iat,exp}`, and a refresh token can NEVER authenticate a normal
 * request (and vice-versa).
 *   node --import tsx --test src/auth/jwt.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createJwt } from "./jwt.ts";

const SECRET = "unit-test-secret-please-change";
const jwt = createJwt({ secret: SECRET });

const decode = (seg: string) => JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));

test("access token round-trips: issue → verify returns {email, role}", () => {
  const token = jwt.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  const principal = jwt.verifyAccessToken(token);
  assert.deepEqual(principal, { email: "admin@workwell.dev", role: "ROLE_ADMIN" });
});

test("access token is HS256 with base64url-no-pad segments and the Java claim shape", () => {
  const token = jwt.issueAccessToken("a@b.dev", "ROLE_AUTHOR");
  const [h, p, s] = token.split(".");
  assert.deepEqual(decode(h!), { alg: "HS256", typ: "JWT" });
  const payload = decode(p!);
  assert.equal(payload.sub, "a@b.dev");
  assert.equal(payload.role, "ROLE_AUTHOR");
  assert.equal(typeof payload.iat, "number");
  assert.equal(typeof payload.exp, "number");
  assert.ok(!/[=+/]/.test(token), "segments are base64url with no padding");
  // signature is HMAC-SHA256 over header.payload
  const expected = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  assert.equal(s, expected);
});

test("refresh token round-trips: issue → verify returns the subject email", () => {
  const token = jwt.issueRefreshToken("case@workwell.dev");
  assert.equal(jwt.verifyRefreshToken(token), "case@workwell.dev");
  assert.equal(decode(token.split(".")[1]!).refresh, true);
});

test("a refresh token cannot authenticate a normal request", () => {
  const refresh = jwt.issueRefreshToken("admin@workwell.dev");
  assert.equal(jwt.verifyAccessToken(refresh), null);
});

test("an access token is not accepted as a refresh token", () => {
  const access = jwt.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  assert.equal(jwt.verifyRefreshToken(access), null);
});

test("a tampered signature is rejected", () => {
  const token = jwt.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  const [h, p] = token.split(".");
  assert.equal(jwt.verifyAccessToken(`${h}.${p}.deadbeef`), null);
});

test("a token signed with a different secret is rejected", () => {
  const other = createJwt({ secret: "a-different-secret-entirely" });
  const token = other.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  assert.equal(jwt.verifyAccessToken(token), null);
});

test("an expired access token is rejected", () => {
  const shortLived = createJwt({ secret: SECRET, accessTtlSeconds: -10 });
  const token = shortLived.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
  assert.equal(jwt.verifyAccessToken(token), null);
});

test("malformed tokens are rejected, not thrown", () => {
  assert.equal(jwt.verifyAccessToken("not-a-token"), null);
  assert.equal(jwt.verifyAccessToken("only.two"), null);
  assert.equal(jwt.verifyRefreshToken(""), null);
});
