/**
 * MCP token primitives (#704): a key and a header typ per kind, each able to refuse on its own; the role
 * ceiling; and a store error reported as unavailable, never as a valid token.
 *   node --import tsx --test src/auth/mcp-token.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { issueSigned, createJwt } from "./jwt.ts";
import { McpStoreUnavailableError, keyFor, readMcpToken, roleWithin, signMcpToken, verifyMcpAccessToken } from "./mcp-token.ts";
import { credentialVersion, findDemoUser } from "./demo-users.ts";

const SECRET = "s".repeat(48);

test("each kind has its own key and its own typ, and either alone refuses a token of another kind", () => {
  assert.notDeepEqual(keyFor(SECRET, "pat"), keyFor(SECRET, "code"));
  assert.notDeepEqual(keyFor(SECRET, "pat"), createHmac("sha256", SECRET).digest(), "never the login secret itself");
  const pat = signMcpToken(SECRET, "pat", { sub: "a" }, 60);
  assert.deepEqual(readMcpToken(SECRET, "pat", pat)?.sub, "a");
  assert.equal(readMcpToken(SECRET, "code", pat), null, "a PAT is not a code");
  // The typ alone: the PAT's key, another kind's typ.
  assert.equal(readMcpToken(SECRET, "pat", issueSigned(keyFor(SECRET, "pat"), "workwell-mcp+code", { sub: "a" }, 60)), null, "wrong typ, right key");
  // The key alone: the PAT's typ, another kind's key.
  assert.equal(readMcpToken(SECRET, "pat", issueSigned(keyFor(SECRET, "code"), "workwell-mcp+pat", { sub: "a" }, 60)), null, "right typ, wrong key");
  assert.equal(readMcpToken("t".repeat(48), "pat", pat), null, "another secret");
});

test("a login token never verifies as an MCP token, and the login verifier refuses anything carrying kind or aud", () => {
  const jwt = createJwt({ secret: SECRET });
  assert.equal(readMcpToken(SECRET, "pat", jwt.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN")), null);
  assert.equal(jwt.verifyAccessToken(signMcpToken(SECRET, "pat", { sub: "admin@workwell.dev", role: "ROLE_ADMIN" }, 60)), null, "an MCP token is not a login token");
  const withAud = issueSigned(SECRET, "JWT", { sub: "admin@workwell.dev", role: "ROLE_ADMIN", aud: "https://x/mcp" }, 60);
  const withKind = issueSigned(SECRET, "JWT", { sub: "admin@workwell.dev", role: "ROLE_ADMIN", kind: "pat" }, 60);
  assert.equal(jwt.verifyAccessToken(withAud), null, "login-signed but with an audience");
  assert.equal(jwt.verifyAccessToken(withKind), null, "login-signed but with a kind");
  assert.deepEqual(jwt.verifyAccessToken(issueSigned(SECRET, "JWT", { sub: "admin@workwell.dev", role: "ROLE_ADMIN" }, 60)), { email: "admin@workwell.dev", role: "ROLE_ADMIN" }, "the control");
});

test("a token's role may be the user's MCP role or lower, never higher and never a non-MCP role", () => {
  assert.equal(roleWithin("ROLE_CASE_MANAGER", "ROLE_ADMIN"), true);
  assert.equal(roleWithin("ROLE_ADMIN", "ROLE_ADMIN"), true);
  assert.equal(roleWithin("ROLE_ADMIN", "ROLE_CASE_MANAGER"), false);
  assert.equal(roleWithin("ROLE_VIEWER", "ROLE_ADMIN"), false);
  assert.equal(roleWithin("ROLE_MCP_CLIENT", "ROLE_ADMIN"), false);
  assert.equal(roleWithin("ROLE_CASE_MANAGER", "ROLE_VIEWER"), false);
});

test("a store error is McpStoreUnavailableError, never a pass and never an ordinary refusal", async () => {
  const admin = findDemoUser("admin@workwell.dev")!;
  const resource = "https://api.test/mcp";
  const token = signMcpToken(SECRET, "pat", { sub: admin.email, role: "ROLE_ADMIN", cv: credentialVersion(admin), aud: resource, jti: "j", fam: "mcp-pat:1" }, 60);
  await assert.rejects(
    verifyMcpAccessToken(token, { secret: SECRET, resource, families: { currentJti: async () => Promise.reject(new Error("down")) } }),
    McpStoreUnavailableError,
  );
  const info = await verifyMcpAccessToken(token, { secret: SECRET, resource, families: { currentJti: async () => "j" } });
  assert.deepEqual(info.extra, { sub: admin.email, role: "ROLE_ADMIN", credential: "pat:1" });
  assert.equal(info.resource?.href, resource);
});
