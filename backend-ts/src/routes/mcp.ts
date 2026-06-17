/**
 * MCP transport (#108) — TS port of the WebMvcSseServerTransportProvider wiring, JVM-free
 * and fetch-native (the official SDK transports assume Node http; our host is Cloudflare-shaped).
 *
 * HTTP+SSE transport (MCP 2024-11-05):
 *   GET  /sse                       open the event stream; first event is the message endpoint
 *                                   `event: endpoint\ndata: /mcp/message?sessionId=<id>`
 *   POST /mcp/message?sessionId=…   JSON-RPC request(s); the response is pushed over THAT session's
 *                                   SSE stream (`event: message`), and the POST returns 202.
 *
 * JSON-RPC methods: initialize, notifications/initialized, ping, tools/list, tools/call.
 * Session state (sessionId → SSE controller) is an in-process Map — valid on the single-process
 * Node host. NOTE: the live remote stream over twh-api/sse is independently throttled by MIE
 * nginx (proxy_read_timeout/buffering); that is an MIE-ops fix, not a backend-language issue.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { ensureMeasureStore } from "./measures.ts";
import { MCP_TOOLS } from "../mcp/tools.ts";
import { callTool, type DispatchCtx } from "../mcp/dispatch.ts";
import type { JsonRecord } from "../mcp/tool-audit.ts";

interface McpEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

/** Auth context resolved by the worker (role null + enforce=false when auth is disabled). */
export interface McpAuth {
  actor: string;
  role: string | null;
  enforce: boolean;
}

const MESSAGE_ENDPOINT = "/mcp/message";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "workwell-mcp", version: "2.0.0" };

const encoder = new TextEncoder();

/** sessionId → SSE stream controller (in-process; single Node host). */
const sessions = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

function sseFrame(event: string, data: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
}

function pushMessage(sessionId: string, message: unknown): boolean {
  const controller = sessions.get(sessionId);
  if (!controller) return false;
  controller.enqueue(sseFrame("message", JSON.stringify(message)));
  return true;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function dispatchCtx(env: McpEnv, auth: McpAuth): Promise<DispatchCtx> {
  // ensureMeasureStore runs schema init + catalog seed; the other stores share the same backend
  // (the factory caches per env, so the measure store and these resolve to one floor/ceiling).
  const measureStore = await ensureMeasureStore(env);
  const s = await getStores(env);
  return {
    deps: {
      caseStore: s.cases,
      outcomeStore: s.outcomes,
      runStore: s.runs,
      measureStore,
    },
    events: s.events,
    actor: auth.actor,
    role: auth.role,
    enforce: auth.enforce,
  };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonRecord;
}

const rpcResult = (id: string | number | null | undefined, result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: string | number | null | undefined, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Process one JSON-RPC message → the response to push (or null for notifications). */
async function handleRpc(msg: JsonRpcMessage, ctx: DispatchCtx): Promise<unknown | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case "notifications/initialized":
      return null; // notification, no response
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as JsonRecord | undefined) ?? {};
      const result = await callTool(name, args, ctx);
      return rpcResult(msg.id, result);
    }
    default:
      return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method ?? ""}`);
  }
}

/** Returns a Response if this module owns the route, else null. */
export async function handleMcp(req: Request, env: McpEnv, auth: McpAuth): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  // GET /sse — open the event stream and announce the message endpoint.
  if (pathname === "/sse" && req.method === "GET") {
    const sessionId = crypto.randomUUID();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sessions.set(sessionId, controller);
        controller.enqueue(sseFrame("endpoint", `${MESSAGE_ENDPOINT}?sessionId=${sessionId}`));
      },
      cancel() {
        sessions.delete(sessionId);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
    });
  }

  // POST /mcp/message?sessionId=… — JSON-RPC; response delivered over the session's SSE stream.
  if (pathname === MESSAGE_ENDPOINT && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!sessions.has(sessionId)) return json({ error: "unknown_session" }, 404);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const messages: JsonRpcMessage[] = Array.isArray(body) ? (body as JsonRpcMessage[]) : [body as JsonRpcMessage];
    const ctx = await dispatchCtx(env, auth);
    for (const msg of messages) {
      const response = await handleRpc(msg, ctx);
      if (response !== null) pushMessage(sessionId, response);
    }
    return new Response(null, { status: 202 });
  }

  return null;
}

/** Test-only: drain the registered session ids (so tests can assert/cleanup). */
export function __mcpSessionCount(): number {
  return sessions.size;
}
