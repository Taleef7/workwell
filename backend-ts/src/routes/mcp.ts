/**
 * MCP transport (#108, #704): Streamable HTTP at `POST /mcp`, served by the official TypeScript SDK v2
 * (`@modelcontextprotocol/server`, owner-approved 2026-10-20).
 *
 * - **Both protocol eras on one endpoint.** 2026-07-28 requests (stateless: `_meta` on every request,
 *   `server/discover`, the `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers) and 2025-era ones
 *   (`initialize` first, which most clients still send) are both answered, statelessly, by a fresh server
 *   per request (`legacy: "stateless"`). The SDK applies each era's header rules: a legacy `initialize`
 *   without a version header is served, as the spec requires.
 * - **One answer per request.** A 2026-07-28 request is answered with plain JSON (`responseMode: "json"`:
 *   every tool answers once, so there is nothing to stream); a 2025-era one with the single-message event
 *   stream that era's transport uses, closed at once, so MIE's proxy has nothing to hold open. GET and
 *   DELETE answer 405.
 * - **The 2024-11-05 HTTP+SSE transport (`GET /sse`, `POST /mcp/message`) is retired.** The spec
 *   deprecates it and the SDK never serves it.
 * - **Checks run here, in front of the SDK,** because the SDK turns anything thrown inside a tool into an
 *   `isError` result and does no Origin or token checks of its own:
 *   1. an `Origin` header, when present, must be one of the CORS origins exactly (a browser page on another
 *      site may not drive the tools); native clients send none;
 *   2. a bearer MCP token (`auth/mcp-token.ts`): only a token minted for this endpoint, never a login token;
 *      a store failure is a 503, never a pass.
 *   The worker's route matrix PERMITs exactly `/mcp` because of this; the actor and role come only from
 *   the verified token.
 * - **Tools.** The 13 read-only tools of `mcp/tools.ts`, each with a title and read-only annotations. Their
 *   input schemas are advertised as they are but validated by `callTool`, not by the SDK (a pass-through
 *   validator), so a call with bad arguments still reaches the audit (`MCP_TOOL_CALLED`), as `docs/MCP.md`
 *   promises. An unknown tool is the SDK's JSON-RPC -32602.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import {
  McpServer,
  bearerAuthChallengeResponse,
  createMcpHandler,
  fromJsonSchema,
  verifyBearerToken,
  type AuthInfo,
  type CallToolResult,
  type JsonSchemaValidator,
  type McpHttpHandler,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { getStores } from "../stores/factory.ts";
import { ensureMeasureStore } from "./measures.ts";
import { MCP_TOOLS, MCP_TOOL_TITLES } from "../mcp/tools.ts";
import { callTool, type DispatchCtx } from "../mcp/dispatch.ts";
import type { JsonRecord } from "../mcp/tool-audit.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";
import { McpStoreUnavailableError, verifyMcpAccessToken } from "../auth/mcp-token.ts";
import { mcpResourceOf, publicApiUrl } from "../config/public-api-url.ts";
import { parseAllowedOrigins } from "../config/cors.ts";

interface McpEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  WORKWELL_AUTH_JWT_SECRET?: string;
  WORKWELL_PUBLIC_API_URL?: string;
  WORKWELL_CORS_ALLOWED_ORIGINS?: string;
}

const SERVER_INFO = { name: "workwell-mcp", version: "3.0.0" };
export const MCP_PATH = "/mcp";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Advertise the real schema, validate nothing: `callTool` validates and audits every call itself. */
const PASS_THROUGH: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

const json = (data: unknown, status: number): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function dispatchCtx(env: McpEnv, authInfo: AuthInfo | undefined, enforce: boolean): Promise<DispatchCtx> {
  // ensureMeasureStore runs schema init + catalog seed; the other stores share the same backend.
  const measureStore = await ensureMeasureStore(env);
  const s = await getStores(env);
  const extra = (authInfo?.extra ?? {}) as { sub?: string; role?: string; credential?: string };
  return {
    deps: {
      caseStore: s.cases,
      outcomeStore: s.outcomes,
      runStore: s.runs,
      measureStore,
      subjectListStore: s.subjectLists,
      webChartEnv: env,
    },
    events: s.events,
    actor: extra.sub ?? "system",
    role: extra.role ?? null,
    enforce,
    ...(extra.credential ? { credential: extra.credential } : {}),
  };
}

/** One server per request, every tool registered; the SDK picks the era from the request. */
function serverFor(env: McpEnv, enforce: boolean, authInfo: AuthInfo | undefined): McpServer {
  // `listChanged: false`: the tool list never changes, and the SDK's default (true) would let a 2026-07-28
  // `subscriptions/listen` hold an event stream open for nothing, against "one answer per request".
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: { listChanged: false } } });
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: MCP_TOOL_TITLES[tool.name] ?? tool.name,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as never, PASS_THROUGH),
        annotations: READ_ONLY,
      },
      async (args: unknown): Promise<CallToolResult> => {
        const ctx = await dispatchCtx(env, authInfo, enforce);
        const result = await callTool(tool.name, (args ?? {}) as JsonRecord, ctx);
        return {
          content: result.content,
          isError: result.isError,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        };
      },
    );
  }
  return server;
}

const handlers = new WeakMap<object, Map<boolean, McpHttpHandler>>();

function handlerFor(env: McpEnv, enforce: boolean): McpHttpHandler {
  let byMode = handlers.get(env);
  if (!byMode) handlers.set(env, (byMode = new Map()));
  let handler = byMode.get(enforce);
  if (!handler) {
    handler = createMcpHandler((ctx) => serverFor(env, enforce, ctx.authInfo), { legacy: "stateless", responseMode: "json" });
    byMode.set(enforce, handler);
  }
  return handler;
}

/** Returns a Response if this module owns the route, else null. `enforce` is the worker's auth switch. */
export async function handleMcp(req: Request, env: McpEnv, opts: { enforce: boolean }): Promise<Response | null> {
  if (new URL(req.url).pathname !== MCP_PATH) return null;

  const origin = req.headers.get("origin");
  if (origin !== null && !parseAllowedOrigins(env.WORKWELL_CORS_ALLOWED_ORIGINS).includes(origin)) {
    return json({ error: "forbidden_origin" }, 403);
  }

  let authInfo: AuthInfo | undefined;
  if (opts.enforce) {
    const pub = publicApiUrl(env, req, true);
    if (!pub.ok) return json({ error: "mcp_unavailable", reason: pub.reason }, 503);
    const resource = mcpResourceOf(pub.origin);
    // A 401 names the Protected Resource Metadata (RFC 9728), so an OAuth-capable client can sign in from it.
    const challenge = { resourceMetadataUrl: `${pub.origin}/.well-known/oauth-protected-resource/mcp`, requiredScopes: ["mcp"] };
    const families = (await getStores(env)).authFamilies;
    let storeDown = false;
    try {
      authInfo = await verifyBearerToken(req.headers.get("authorization"), {
        ...challenge,
        expectedResource: new URL(resource),
        verifier: {
          verifyAccessToken: async (token: string) => {
            try {
              return await verifyMcpAccessToken(token, { secret: env.WORKWELL_AUTH_JWT_SECRET ?? "", resource, families });
            } catch (err) {
              if (err instanceof McpStoreUnavailableError) storeDown = true;
              throw err;
            }
          },
        },
      });
    } catch (err) {
      if (storeDown) return json({ error: "mcp_unavailable", reason: "token store unavailable" }, 503);
      return bearerAuthChallengeResponse(err, challenge);
    }
  }
  return handlerFor(env, opts.enforce).fetch(req, authInfo ? { authInfo } : undefined);
}
