/**
 * OAuth clients with nothing stored: self-registration (loopback only, signed) and CIMD resolution.
 *   node --import tsx --test src/auth/oauth/clients.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerClient, resolveClient, ClientError } from "./clients.ts";
import { __clearCimdCache, type CimdDeps } from "./cimd.ts";
import { signMcpToken } from "../mcp-token.ts";

const SECRET = "c".repeat(48);
beforeEach(() => __clearCimdCache());

test("self-registration returns a signed client id that resolves back to the registration", async () => {
  const reg = registerClient(SECRET, { client_name: "mcp-remote", redirect_uris: ["http://localhost:4123/oauth/callback"], token_endpoint_auth_method: "none" });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.token_endpoint_auth_method, "none");
  const client = await resolveClient(SECRET, reg.body.client_id as string);
  assert.deepEqual(client, { clientId: reg.body.client_id, clientName: "mcp-remote", redirectUris: ["http://localhost:4123/oauth/callback"], trust: "dcr" });
});

test("self-registration refuses https redirects, other auth methods, other grants and bad bodies", () => {
  const status = (body: unknown) => registerClient(SECRET, body).status;
  assert.equal(status({ client_name: "Claude", redirect_uris: ["https://attacker.example/cb"] }), 400, "no https for an unverified client");
  assert.equal(status({ redirect_uris: ["http://localhost/cb"], token_endpoint_auth_method: "client_secret_basic" }), 400);
  assert.equal(status({ redirect_uris: ["http://localhost/cb"], grant_types: ["client_credentials"] }), 400);
  assert.equal(status({ redirect_uris: ["http://localhost/cb"], response_types: ["token"] }), 400);
  assert.equal(status({ redirect_uris: [] }), 400);
  assert.equal(status([]), 400);
  assert.equal(status(null), 400);
  assert.equal(registerClient(SECRET, { redirect_uris: ["http://127.0.0.1/cb"] }).body.client_name, "Unnamed MCP client");
});

test("a client id is refused when it is forged, of another kind, from another secret, or lists an https redirect", async () => {
  await assert.rejects(resolveClient(SECRET, "made-up-client"), ClientError);
  await assert.rejects(resolveClient(SECRET, signMcpToken(SECRET, "pat", { client_name: "x", redirect_uris: ["http://localhost/cb"] }, 60)), ClientError);
  await assert.rejects(resolveClient(SECRET, signMcpToken("z".repeat(48), "client", { client_name: "x", redirect_uris: ["http://localhost/cb"] }, 60)), ClientError);
  await assert.rejects(resolveClient(SECRET, signMcpToken(SECRET, "client", { client_name: "x", redirect_uris: ["https://claude.ai/cb"] }, 60)), ClientError, "a blob may never carry https");
});

test("an https client id resolves through its metadata document, with its host as identity", async () => {
  const doc = { client_id: "https://claude.ai/oauth/claude-code-client-metadata", client_name: "Claude Code", redirect_uris: ["http://localhost/callback"] };
  const request: NonNullable<CimdDeps["request"]> = (_url, _options, onResponse) => {
    const req = Object.assign(new EventEmitter(), { end() { const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, resume() {} }); setImmediate(() => { onResponse(res as never); res.emit("data", Buffer.from(JSON.stringify(doc))); res.emit("end"); }); }, destroy() {} });
    return req as never;
  };
  const client = await resolveClient(SECRET, doc.client_id, { request });
  assert.equal(client.trust, "cimd");
  assert.equal(client.host, "claude.ai");
  await assert.rejects(resolveClient(SECRET, "https://claude.ai/"), ClientError, "a refused client_id URL");
});
