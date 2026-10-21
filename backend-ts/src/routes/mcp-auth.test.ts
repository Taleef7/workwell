/**
 * MCP tokens end to end through the worker (#704): an admin mints one, it works on /mcp and nowhere else,
 * and every way of presenting the wrong thing is refused. Mint and revoke are audited first, and a store
 * failure fails closed.
 *   node --import tsx --test src/routes/mcp-auth.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import worker, { type Env } from "../worker.ts";
import { createJwt } from "../auth/jwt.ts";
import { signMcpToken } from "../auth/mcp-token.ts";
import { credentialVersion, findDemoUser } from "../auth/demo-users.ts";
import { SqliteAuthFamilyStore } from "../stores/sqlite/auth-family-store-sqlite.ts";

const SECRET = "m".repeat(48);
const PUBLIC = "https://api.workwell.test";
const RESOURCE = `${PUBLIC}/mcp`;
const dbPath = join(tmpdir(), `workwell-mcpauth-${crypto.randomUUID()}.sqlite`);
const env = { WORKWELL_AUTH_JWT_SECRET: SECRET, WORKWELL_PUBLIC_API_URL: PUBLIC } as unknown as Env;
const ctx = {} as never;
const login = createJwt({ secret: SECRET });
const ADMIN = login.issueAccessToken("admin@workwell.dev", "ROLE_ADMIN");
const CM = login.issueAccessToken("cm@workwell.dev", "ROLE_CASE_MANAGER");

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

const call = (path: string, init: RequestInit = {}, theEnv: Env = env) => worker.fetch(new Request(`http://x${path}`, init), theEnv, ctx);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const db = () => (env as unknown as { DB: { prepare: (sql: string) => { all: <T>() => Promise<{ results?: T[] }> } } }).DB;

async function mint(body: Record<string, unknown> = { label: "test" }, token = ADMIN): Promise<Response> {
  return call("/api/admin/mcp-tokens", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function minted(body: Record<string, unknown> = { label: "test" }): Promise<{ token: string; tokenId: string; role: string; expiresAt: string; mcpUrl: string }> {
  const res = await mint(body);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as never;
}

const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
function mcp(token: string | null, method = "tools/list", params: Record<string, unknown> = {}, name?: string, theEnv: Env = env) {
  return call(
    "/mcp",
    {
      method: "POST",
      headers: {
        ...(token ? bearer(token) : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: MODERN_META } }),
    },
    theEnv,
  );
}

test("an admin mints a token for /mcp: shown once, Case Manager by default, 30 days, with the MCP URL", async () => {
  const t = await minted({ label: "Claude Desktop" });
  assert.equal(t.role, "ROLE_CASE_MANAGER");
  assert.equal(t.mcpUrl, RESOURCE);
  const days = (Date.parse(t.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `about 30 days (${days})`);
  assert.equal((await mcp(t.token)).status, 200);
});

test("the token reaches the tools as its minter, with its own role, and the tool audit names the credential", async () => {
  const t = await minted({ label: "audit", role: "ROLE_ADMIN" });
  const res = await mcp(t.token, "tools/call", { name: "list_runs", arguments: {} }, "list_runs");
  const body = (await res.json()) as { result: { isError: boolean } };
  assert.equal(body.result.isError, false);
  const rows = (await db().prepare("SELECT actor, payload_json AS p FROM audit_events WHERE event_type = 'MCP_TOOL_CALLED' ORDER BY id DESC LIMIT 1").all<{ actor: string; p: string }>()).results!;
  assert.equal(rows[0]!.actor, "admin@workwell.dev", "the actor is the token's subject, never 'system'");
  assert.equal(JSON.parse(rows[0]!.p).credential, `pat:${t.tokenId}`);
});

test("an MCP token is refused everywhere else: the API, auth refresh, CDS invoke and $cql", async () => {
  const t = await minted();
  for (const [path, method] of [
    ["/api/cases", "GET"],
    ["/api/runs", "GET"],
    ["/api/admin/mcp-tokens", "GET"],
    ["/api/auth/refresh", "POST"],
    ["/cds-services/workwell-care-gaps", "POST"],
    ["/$cql", "POST"],
  ] as const) {
    const res = await call(path, { method, headers: { ...bearer(t.token), "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.ok(res.status === 401, `${method} ${path} with an MCP token: ${res.status}`);
  }
});

test("a login token, a token of another kind, another audience, a stale credential version or a higher role is refused on /mcp", async () => {
  assert.equal((await mcp(ADMIN)).status, 401, "a login access token is not an MCP token");
  assert.equal((await mcp(null)).status, 401, "no token");
  const t = await minted();
  const families = new SqliteAuthFamilyStore(db() as never);
  const admin = findDemoUser("admin@workwell.dev")!;
  const forge = async (kind: "pat" | "code" | "oauth-refresh" | "oauth-access", over: Record<string, unknown> = {}) => {
    const fam = `mcp-pat:${randomUUID()}`;
    const jti = randomUUID();
    await families.rotate(fam, jti, new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString());
    return signMcpToken(SECRET, kind, { sub: admin.email, role: "ROLE_CASE_MANAGER", cv: credentialVersion(admin), aud: RESOURCE, jti, fam, ...over }, 3600);
  };
  assert.equal((await mcp(await forge("pat"))).status, 200, "the control: a well-formed PAT passes");
  assert.equal((await mcp(await forge("code"))).status, 401, "a code is not a bearer token");
  assert.equal((await mcp(await forge("oauth-refresh"))).status, 401, "nor is a refresh token");
  assert.equal((await mcp(await forge("pat", { aud: "https://elsewhere.test/mcp" }))).status, 401, "another audience");
  assert.equal((await mcp(await forge("pat", { cv: "stale-version" }))).status, 401, "minted before a password change");
  assert.equal((await mcp(await forge("pat", { sub: "cm@workwell.dev", role: "ROLE_ADMIN", cv: credentialVersion(findDemoUser("cm@workwell.dev")!) }))).status, 401, "a role above the user's");
  assert.equal((await mcp(await forge("pat", { sub: "viewer@workwell.dev", cv: credentialVersion(findDemoUser("viewer@workwell.dev")!) }))).status, 401, "a user who cannot use MCP");
  assert.equal((await mcp(await forge("pat", { sub: "nobody@workwell.dev" }))).status, 401, "a subject that is no account");
  const parts = t.token.split(".");
  assert.equal((await mcp(`${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}`)).status, 401, "a tampered signature");
  const expired = signMcpToken(SECRET, "pat", { sub: admin.email, role: "ROLE_CASE_MANAGER", cv: credentialVersion(admin), aud: RESOURCE, jti: "j", fam: `mcp-pat:${randomUUID()}` }, -1);
  assert.equal((await mcp(expired)).status, 401, "expired");
  const unauthorized = await mcp(null);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer/, "a 401 carries the Bearer challenge");
});

test("revoking a token ends it at once, and the list shows active, revoked and expired", async () => {
  const keep = await minted({ label: "keep" });
  const drop = await minted({ label: "drop" });
  assert.equal((await call(`/api/admin/mcp-tokens/${drop.tokenId}`, { method: "DELETE", headers: bearer(ADMIN) })).status, 204);
  assert.equal((await mcp(drop.token)).status, 401, "revoked");
  assert.equal((await mcp(keep.token)).status, 200, "the other token is untouched");
  assert.equal((await call(`/api/admin/mcp-tokens/${randomUUID()}`, { method: "DELETE", headers: bearer(ADMIN) })).status, 404);

  const { events } = await import("../stores/factory.ts").then((m) => m.getStores(env));
  const lapsedId = randomUUID();
  await events.appendAudit({
    eventType: "MCP_TOKEN_ISSUED", entityType: "mcp_token", entityId: lapsedId, actor: "admin@workwell.dev",
    refRunId: null, refCaseId: null, refMeasureVersionId: null,
    payload: { tokenId: lapsedId, label: "lapsed", role: "ROLE_CASE_MANAGER", subject: "admin@workwell.dev", expiresAt: "2026-01-01T00:00:00.000Z" },
  });
  const list = (await (await call("/api/admin/mcp-tokens", { headers: bearer(ADMIN) })).json()) as { tokens: Array<{ tokenId: string; status: string; label: string }> };
  const status = (id: string) => list.tokens.find((t) => t.tokenId === id)?.status;
  assert.equal(status(keep.tokenId), "active");
  assert.equal(status(drop.tokenId), "revoked");
  assert.equal(status(lapsedId), "expired", "expiry is read from the event, since a lapsed row is purged");
  assert.ok(!JSON.stringify(list).includes(keep.token), "the list never holds a token");
});

test("minting refuses bad input, a non-admin, and a role it cannot grant", async () => {
  for (const body of [{ label: "" }, { label: "x".repeat(61) }, { label: "ok", days: 0 }, { label: "ok", days: 91 }, { label: "ok", days: 1.5 }, { label: "ok", role: "ROLE_VIEWER" }, { label: "ok", role: "ROLE_MCP_CLIENT" }]) {
    assert.equal((await mint(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await mint({ label: "ok" }, CM)).status, 403, "only an admin mints");
  assert.equal((await mint({ label: "ninety", days: 90 })).status, 201, "90 days is the cap, inclusive");
});

test("mint and revoke are audited first: a failed store write leaves the event and issues nothing (503)", async () => {
  const proto = SqliteAuthFamilyStore.prototype as unknown as Record<string, unknown>;
  const rotate = proto.rotate;
  proto.rotate = async () => {
    throw new Error("store down");
  };
  let res: Response;
  try {
    res = await mint({ label: "half" });
  } finally {
    proto.rotate = rotate;
  }
  assert.equal(res.status, 503);
  assert.ok(!(await res.text()).includes("."), "no token in the refusal");
  const issued = (await db().prepare("SELECT payload_json AS p FROM audit_events WHERE event_type = 'MCP_TOKEN_ISSUED'").all<{ p: string }>()).results!;
  assert.ok(issued.some((r) => JSON.parse(r.p).label === "half"), "the event was written before the row");
  assert.ok(issued.every((r) => !("token" in JSON.parse(r.p))), "no issued event ever holds a token");

  const t = await minted({ label: "revoke-half" });
  const revoke = proto.revoke;
  proto.revoke = async () => {
    throw new Error("store down");
  };
  try {
    assert.equal((await call(`/api/admin/mcp-tokens/${t.tokenId}`, { method: "DELETE", headers: bearer(ADMIN) })).status, 503);
  } finally {
    proto.revoke = revoke;
  }
  const revoked = (await db().prepare("SELECT entity_id AS id FROM audit_events WHERE event_type = 'MCP_TOKEN_REVOKED'").all<{ id: string }>()).results!;
  assert.ok(revoked.some((r) => r.id === t.tokenId), "the revoke event was written before the delete");
});

test("a store that cannot be read fails closed: /mcp answers 503, never 200", async () => {
  const t = await minted();
  const proto = SqliteAuthFamilyStore.prototype as unknown as Record<string, unknown>;
  const currentJti = proto.currentJti;
  proto.currentJti = async () => {
    throw new Error("store down");
  };
  try {
    assert.equal((await mcp(t.token)).status, 503);
  } finally {
    proto.currentJti = currentJti;
  }
  assert.equal((await mcp(t.token)).status, 200, "and works again once the store does");
});

test("without auth credentials no path under /mcp answers 200, whatever the method", async () => {
  for (const path of ["/mcp", "/mcp/", "/mcp/message", "/sse"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await call(path, { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined });
      assert.notEqual(res.status, 200, `${method} ${path}`);
    }
  }
});

test("without WORKWELL_PUBLIC_API_URL only MCP is unavailable (503); the rest of the API answers", async () => {
  const bare = { WORKWELL_AUTH_JWT_SECRET: SECRET, DB: (env as unknown as { DB: unknown }).DB } as unknown as Env;
  const t = await minted();
  assert.equal((await mcp(t.token, "tools/list", {}, undefined, bare)).status, 503);
  assert.equal((await call("/api/admin/mcp-tokens", { method: "POST", headers: { ...bearer(ADMIN), "content-type": "application/json" }, body: JSON.stringify({ label: "x" }) }, bare)).status, 503);
  assert.equal((await call("/health", {}, bare)).status, 200);
  assert.equal((await call("/api/runs", { headers: bearer(ADMIN) }, bare)).status, 200);
});
