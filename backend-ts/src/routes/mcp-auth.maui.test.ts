/**
 * On Maui, an MCP token obeys the same profile rule as a login (#520, #704): a demo account that belongs
 * to another deployment is refused, the pilot's own admin is served.
 *   node --import tsx --test src/routes/mcp-auth.maui.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const script = `
  import worker from "./src/worker.ts";
  import { signMcpToken } from "./src/auth/mcp-token.ts";
  import { credentialVersion, DEMO_USERS } from "./src/auth/demo-users.ts";
  import { SqliteAuthFamilyStore } from "./src/stores/sqlite/auth-family-store-sqlite.ts";
  import { getStores } from "./src/stores/factory.ts";
  import { createSqliteD1 } from "@mieweb/cloud-local";

  // The catalog seed logs to stdout at run time; the parent parses stdout as one JSON line.
  const print = console.log;
  console.log = () => {};
  const secret = "m".repeat(48);
  const resource = "https://api.workwell.test/mcp";
  const db = await createSqliteD1(":memory:");
  const env = { DB: db, WORKWELL_AUTH_JWT_SECRET: secret, WORKWELL_PUBLIC_API_URL: "https://api.workwell.test" };
  await getStores(env);
  const families = new SqliteAuthFamilyStore(db);
  const statusFor = async (email) => {
    const user = DEMO_USERS.find((u) => u.email === email);
    const fam = "mcp-pat:" + crypto.randomUUID();
    await families.rotate(fam, "j", new Date(Date.now() + 3600000).toISOString(), new Date().toISOString());
    const token = signMcpToken(secret, "pat", { sub: email, role: "ROLE_ADMIN", cv: credentialVersion(user), aud: resource, jti: "j", fam }, 3600);
    const res = await worker.fetch(new Request("http://x/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }), env, {});
    return res.status;
  };
  print(JSON.stringify({ twhAdmin: await statusFor("admin@workwell.dev"), mauiAdmin: await statusFor("admin@maui.workwell.dev") }));
`;

test("on maui, a token for another deployment's demo admin is refused and the pilot admin's is served", () => {
  const out = runProfileChild("maui", script);
  assert.equal(out.twhAdmin, 401);
  assert.equal(out.mauiAdmin, 200);
});
