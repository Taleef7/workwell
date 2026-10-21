/**
 * MCP transport (#108, #704): Streamable HTTP at POST /mcp, both protocol eras, through the SDK v2 handler.
 * Auth is off here (`enforce: false`); the token gate is `mcp-auth.test.ts`.
 *   node --import tsx --test src/routes/mcp.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { MCP_TOOLS } from "../mcp/tools.ts";
import { handleMcp } from "./mcp.ts";

const dbPath = join(tmpdir(), `workwell-mcproute-${crypto.randomUUID()}.sqlite`);
let env: { DB: { prepare: (sql: string) => { all: <T>() => Promise<{ results?: T[] }> } } };
let runId: string;

const ACCEPT = "application/json, text/event-stream";
const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };

async function send(body: unknown, headers: Record<string, string> = {}, method = "POST"): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", accept: ACCEPT, ...headers } };
  if (method === "POST") init.body = JSON.stringify(body);
  return (await handleMcp(new Request("http://x/mcp", init), env as never, { enforce: false }))!;
}

/** The JSON-RPC message of a response, plain JSON (2026-07-28) or a one-message event stream (2025 era). */
async function rpcOf(res: Response): Promise<Rpc> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.match(/^data: (.*)$/m);
    assert.ok(data, `an event-stream message: ${text}`);
    return JSON.parse(data![1]!) as Rpc;
  }
  return JSON.parse(text) as Rpc;
}

const modern = (id: number, method: string, params: Record<string, unknown> = {}, name?: string) =>
  send(
    { jsonrpc: "2.0", id, method, params: { ...params, _meta: MODERN_META } },
    { "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
  );
const legacy = (id: number, method: string, params?: Record<string, unknown>) =>
  send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, { "mcp-protocol-version": "2025-11-25" });

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  await migrateFloorSchema(db);
  env = { DB: db };
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  runId = run.id;
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("only POST /mcp is this route: /sse and /mcp/message (the retired 2024-11-05 transport) are not", async () => {
  for (const [path, method] of [["/sse", "GET"], ["/mcp/message", "POST"], ["/mcp/", "POST"]] as const) {
    assert.equal(await handleMcp(new Request(`http://x${path}`, { method }), env as never, { enforce: false }), null, path);
  }
  assert.equal((await send(undefined, { accept: "text/event-stream" }, "GET")).status, 405, "GET (a 2025 session stream) is 405");
  assert.equal((await send(undefined, {}, "DELETE")).status, 405);
});

test("2026-07-28: server/discover names the version, and tools/list carries resultType and private cache hints", async () => {
  const discover = await rpcOf(await modern(1, "server/discover"));
  assert.ok((discover.result!.supportedVersions as string[]).includes("2026-07-28"));
  const list = await modern(2, "tools/list");
  assert.match(list.headers.get("content-type") ?? "", /application\/json/, "a 2026-07-28 answer is plain JSON");
  const { result } = await rpcOf(list);
  assert.equal(result!.resultType, "complete");
  assert.equal(result!.cacheScope, "private");
  assert.equal(typeof result!.ttlMs, "number");
  const tools = result!.tools as Array<{ name: string; title?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }>;
  assert.deepEqual(tools.map((t) => t.name).sort(), MCP_TOOLS.map((t) => t.name).sort(), "all 13 tools");
  for (const tool of tools) {
    assert.ok(tool.title && tool.title !== tool.name, `${tool.name} has a title`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is read-only`);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.deepEqual(tool.inputSchema, MCP_TOOLS.find((t) => t.name === tool.name)!.inputSchema, `${tool.name} advertises its own schema`);
  }
});

test("2025 era: initialize WITHOUT a version header is served, then tools/list and tools/call work", async () => {
  const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.status, 200, "the spec says to assume 2025-03-26 when the header is absent");
  const initResult = (await rpcOf(init)).result!;
  assert.equal((initResult.serverInfo as { name: string }).name, "workwell-mcp");
  assert.ok((initResult.capabilities as Record<string, unknown>).tools);

  assert.equal(((await rpcOf(await legacy(2, "tools/list"))).result!.tools as unknown[]).length, MCP_TOOLS.length);

  const call = (await rpcOf(await legacy(3, "tools/call", { name: "get_run_summary", arguments: { runId } }))).result as {
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
    isError: boolean;
  };
  assert.equal(call.isError, false);
  assert.equal((JSON.parse(call.content[0]!.text) as Record<string, unknown>).run_id, runId);
  assert.equal(call.structuredContent?.run_id, runId, "an object payload is also structuredContent");
});

test("2026-07-28: an unknown tool is JSON-RPC -32602; an unsupported version is 400 -32022; a missing Mcp-Method is 400 -32020", async () => {
  assert.equal((await rpcOf(await modern(1, "tools/call", { name: "no_such_tool", arguments: {} }, "no_such_tool"))).error?.code, -32602);

  const unsupported = await send(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } },
    { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
  );
  assert.equal(unsupported.status, 400);
  assert.equal((await rpcOf(unsupported)).error?.code, -32022);

  const noMethodHeader = await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: MODERN_META } }, { "mcp-protocol-version": "2026-07-28" });
  assert.equal(noMethodHeader.status, 400);
  assert.equal((await rpcOf(noMethodHeader)).error?.code, -32020);
});

test("an invalid tool argument still reaches the tool, which refuses it and audits the call (MCP_TOOL_CALLED)", async () => {
  const failedCalls = async () =>
    Number(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_events WHERE event_type = 'MCP_TOOL_CALLED' AND payload_json LIKE '%\"toolName\":\"get_case\"%' AND payload_json LIKE '%\"success\":false%'",
        ).all<{ n: number }>()
      ).results![0]!.n,
    );
  const before = await failedCalls();
  const result = (await rpcOf(await modern(1, "tools/call", { name: "get_case", arguments: {} }, "get_case"))).result as { isError: boolean };
  assert.equal(result.isError, true, "the missing caseId is the tool's own error, not an SDK schema refusal");
  assert.equal(await failedCalls(), before + 1, "the refused call is audited once");
});

test("an Origin header must be one of the CORS origins exactly; a request without one (a native client) passes", async () => {
  assert.equal((await modern(1, "tools/list").then((r) => r.status)), 200, "no Origin");
  const allowed = await send(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: MODERN_META } },
    { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", origin: "http://localhost:3000" },
  );
  assert.equal(allowed.status, 200, "the default CORS origin");
  for (const origin of ["https://evil.example", "http://localhost:3001", "https://localhost:3000"]) {
    const res = await send(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: MODERN_META } },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", origin },
    );
    assert.equal(res.status, 403, origin);
  }
});
