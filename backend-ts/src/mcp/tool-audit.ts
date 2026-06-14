/**
 * MCP per-call audit (#108) — TS port of McpServerConfig's recordMcpAudit / sanitizeArgs /
 * hashArgs / resultSize. Every tool call (success OR denial/failure) writes one
 * `MCP_TOOL_CALLED` audit_events row (entity_type 'mcp_tool') via CaseEventStore.appendAudit.
 *
 * Arguments are sanitized (never logged raw) and additionally fingerprinted with a SHA-256
 * hash of the sanitized form, so a call is auditable without persisting sensitive inputs.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";

export type JsonRecord = Record<string, unknown>;

/** Collapse a value to an audit-safe form: scalars pass; objects/arrays → {size}; long strings truncated. */
export function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return { size: value.length };
  if (typeof value === "object") return { size: Object.keys(value as object).length };
  const text = String(value);
  return text.length <= 256 ? text : `${text.slice(0, 253)}...`;
}

export function sanitizeArgs(args: JsonRecord | null | undefined): JsonRecord {
  const out: JsonRecord = {};
  if (!args) return out;
  for (const [k, v] of Object.entries(args)) out[k] = sanitizeValue(v);
  return out;
}

/** SHA-256 hex of the sanitized args JSON (portable: Web Crypto, available in Node + Workers). */
export async function hashArgs(args: JsonRecord | null | undefined): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(sanitizeArgs(args)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function resultSize(payload: unknown): number {
  if (payload === null || payload === undefined) return 0;
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload === "object") return Object.keys(payload as object).length;
  return 1;
}

export interface McpAuditInput {
  toolName: string;
  actor: string;
  args: JsonRecord | null | undefined;
  resultPayload: unknown;
  success: boolean;
  sensitivityLabel: string;
  occurredAt: string;
  failureMessage?: string | null;
}

export async function recordMcpAudit(events: Pick<CaseEventStore, "appendAudit">, input: McpAuditInput): Promise<void> {
  const payload: JsonRecord = {
    toolName: input.toolName,
    sanitizedArguments: sanitizeArgs(input.args),
    argumentHash: await hashArgs(input.args),
    resultSize: resultSize(input.resultPayload),
    success: input.success,
    sensitivityLabel: input.sensitivityLabel,
    timestamp: input.occurredAt,
  };
  if (input.failureMessage && input.failureMessage.trim()) payload.failureMessage = input.failureMessage;
  await events.appendAudit({
    eventType: "MCP_TOOL_CALLED",
    entityType: "mcp_tool",
    entityId: crypto.randomUUID(),
    actor: input.actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload,
  });
}
