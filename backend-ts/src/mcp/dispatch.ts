/**
 * MCP tool dispatch (#108) — TS port of McpServerConfig.executeTool: the role gate
 * (requireAnyAuthority) + per-call audit + CallToolResult shaping around each tool handler.
 *
 * Faithful to the Java control flow:
 *  - denied authority → audit failure ("ACCESS_DENIED: …"), return a structured ACCESS_DENIED
 *    result (isError=false, the denial is the payload — same as Java returning safeError);
 *  - handler throws (bad args / not found) → audit failure, return isError=true with the message;
 *  - handler returns a payload (incl. a returned safeError) → audit success.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { recordMcpAudit, type JsonRecord } from "./tool-audit.ts";
import { MCP_TOOLS_BY_NAME, ToolArgError, safeError, type McpToolDeps } from "./tools.ts";

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export interface DispatchCtx {
  deps: McpToolDeps;
  events: Pick<CaseEventStore, "appendAudit">;
  actor: string;
  /** Authenticated authority (e.g. ROLE_CASE_MANAGER); null when auth is disabled. */
  role: string | null;
  /** When false (auth disabled), per-tool role gates are skipped (worker-level permitAll). */
  enforce: boolean;
}

const text = (payload: unknown, isError: boolean): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  isError,
});

export async function callTool(toolName: string, args: JsonRecord, ctx: DispatchCtx): Promise<CallToolResult> {
  const tool = MCP_TOOLS_BY_NAME[toolName];
  if (!tool) return text(safeError("UNKNOWN_TOOL", `Unknown tool: ${toolName}`), true);
  const occurredAt = new Date().toISOString();

  // Per-tool role gate (the transport already restricted to ADMIN/CASE_MANAGER/MCP_CLIENT).
  if (ctx.enforce && !(ctx.role != null && tool.roles.includes(ctx.role))) {
    const message = `Not authorized to call MCP tool: ${toolName}`;
    await recordMcpAudit(ctx.events, {
      toolName,
      actor: ctx.actor,
      args,
      resultPayload: {},
      success: false,
      sensitivityLabel: tool.sensitivity,
      occurredAt,
      failureMessage: `ACCESS_DENIED: ${message}`,
    });
    return text(safeError("ACCESS_DENIED", message), false);
  }

  try {
    const payload = await tool.handler(args, ctx.deps);
    await recordMcpAudit(ctx.events, {
      toolName,
      actor: ctx.actor,
      args,
      resultPayload: payload,
      success: true,
      sensitivityLabel: tool.sensitivity,
      occurredAt,
    });
    return text(payload, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordMcpAudit(ctx.events, {
      toolName,
      actor: ctx.actor,
      args,
      resultPayload: {},
      success: false,
      sensitivityLabel: tool.sensitivity,
      occurredAt,
      failureMessage: message,
    });
    // Bad-argument / not-found errors are tool-execution errors (isError=true), not transport errors.
    if (err instanceof ToolArgError) return text({ error: true, code: "TOOL_ERROR", message }, true);
    return text({ error: true, code: "TOOL_ERROR", message }, true);
  }
}
