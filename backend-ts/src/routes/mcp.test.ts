/**
 * MCP transport route test (#108) — the HTTP+SSE + JSON-RPC handshake end-to-end:
 * open /sse, read the endpoint event for the sessionId, POST JSON-RPC to /mcp/message,
 * read the response back off the SSE stream. Covers initialize, tools/list, tools/call,
 * unknown session (404), unknown method, and the auth-enforced per-tool role gate.
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
import { handleMcp, type McpAuth } from "./mcp.ts";

const dbPath = join(tmpdir(), `workwell-mcproute-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let runId: string;

const PERMISSIVE: McpAuth = { actor: "cm@workwell.dev", role: null, enforce: false };

/** Open /sse, return the stream reader + decoder + the sessionId from the endpoint event. */
async function openSse(): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; decode: (u: Uint8Array) => string; sessionId: string }> {
  const res = await handleMcp(new Request("http://x/sse", { method: "GET" }), env as never, PERMISSIVE);
  assert.equal(res?.status, 200);
  assert.match(res!.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res!.body!.getReader();
  const dec = new TextDecoder();
  const decode = (u: Uint8Array) => dec.decode(u);
  const first = await reader.read();
  const text = decode(first.value!);
  const m = text.match(/data: \/mcp\/message\?sessionId=([0-9a-f-]+)/);
  assert.ok(m, `endpoint event present: ${text}`);
  return { reader, decode, sessionId: m![1]! };
}

/** POST a JSON-RPC message for a session, then read the next SSE message frame's JSON. */
async function rpc(
  sessionId: string,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decode: (u: Uint8Array) => string,
  body: unknown,
  auth: McpAuth = PERMISSIVE,
): Promise<Record<string, unknown>> {
  const res = await handleMcp(
    new Request(`http://x/mcp/message?sessionId=${sessionId}`, { method: "POST", body: JSON.stringify(body) }),
    env as never,
    auth,
  );
  assert.equal(res?.status, 202);
  const chunk = await reader.read();
  const text = decode(chunk.value!);
  const m = text.match(/data: (.*)\n\n$/s);
  assert.ok(m, `message frame present: ${text}`);
  return JSON.parse(m![1]!) as Record<string, unknown>;
}

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

test("GET /sse opens an event stream and announces the message endpoint + sessionId", async () => {
  const { reader, sessionId } = await openSse();
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  await reader.cancel();
});

test("initialize returns serverInfo + tools capability", async () => {
  const { reader, decode, sessionId } = await openSse();
  const resp = await rpc(sessionId, reader, decode, { jsonrpc: "2.0", id: 1, method: "initialize" });
  const result = resp.result as Record<string, unknown>;
  assert.equal((result.serverInfo as Record<string, unknown>).name, "workwell-mcp");
  assert.ok((result.capabilities as Record<string, unknown>).tools);
  await reader.cancel();
});

test("tools/list returns all 13 tool schemas", async () => {
  const { reader, decode, sessionId } = await openSse();
  const resp = await rpc(sessionId, reader, decode, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (resp.result as { tools: unknown[] }).tools;
  assert.equal(tools.length, 13);
  assert.ok((tools[0] as Record<string, unknown>).inputSchema);
  await reader.cancel();
});

test("tools/call get_run_summary returns a CallToolResult over the stream", async () => {
  const { reader, decode, sessionId } = await openSse();
  const resp = await rpc(sessionId, reader, decode, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_run_summary", arguments: { runId } },
  });
  const result = resp.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  assert.equal(payload.run_id, runId);
  await reader.cancel();
});

test("POST to an unknown session is 404", async () => {
  const res = await handleMcp(
    new Request("http://x/mcp/message?sessionId=does-not-exist", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }),
    env as never,
    PERMISSIVE,
  );
  assert.equal(res?.status, 404);
});

test("unknown method returns a JSON-RPC -32601 error", async () => {
  const { reader, decode, sessionId } = await openSse();
  const resp = await rpc(sessionId, reader, decode, { jsonrpc: "2.0", id: 9, method: "no/such/method" });
  assert.equal((resp.error as Record<string, unknown>).code, -32601);
  await reader.cancel();
});

test("notifications/initialized produces no stream response (next frame is the following request's)", async () => {
  const { reader, decode, sessionId } = await openSse();
  // a notification has no id → no SSE frame; the next read should be the ping response
  const res = await handleMcp(
    new Request(`http://x/mcp/message?sessionId=${sessionId}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
    env as never,
    PERMISSIVE,
  );
  assert.equal(res?.status, 202);
  const resp = await rpc(sessionId, reader, decode, { jsonrpc: "2.0", id: 7, method: "ping" });
  assert.deepEqual(resp.result, {});
  await reader.cancel();
});

test("auth-enforced per-tool role gate: MCP_CLIENT denied, CASE_MANAGER allowed", async () => {
  const { reader, decode, sessionId } = await openSse();
  const deniedAuth: McpAuth = { actor: "mcp@x", role: "ROLE_MCP_CLIENT", enforce: true };
  const denied = await rpc(sessionId, reader, decode, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_run_summary", arguments: { runId } } }, deniedAuth);
  const deniedPayload = JSON.parse((denied.result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
  assert.equal(deniedPayload.code, "ACCESS_DENIED");

  const cmAuth: McpAuth = { actor: "cm@x", role: "ROLE_CASE_MANAGER", enforce: true };
  const ok = await rpc(sessionId, reader, decode, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_run_summary", arguments: { runId } } }, cmAuth);
  const okResult = ok.result as { isError: boolean };
  assert.equal(okResult.isError, false);
  await reader.cancel();
});
