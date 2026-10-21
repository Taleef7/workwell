"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@mieweb/ui";
import { useApi } from "@/lib/api/hooks";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * Admin → MCP access (#704): mint a token for Claude Desktop or Claude Code, see it once, list and revoke.
 * The token is valid only on the API's `/mcp`; the server never returns it again after the mint response.
 */

type McpRole = "ROLE_CASE_MANAGER" | "ROLE_ADMIN";

export interface IssuedToken {
  token: string;
  tokenId: string;
  label: string;
  role: McpRole;
  subject: string;
  expiresAt: string;
  mcpUrl: string;
}

export interface TokenRow {
  /** A personal token minted here, or a client connected through OAuth sign-in. */
  kind?: "token" | "oauth";
  tokenId: string;
  label: string;
  role: string;
  subject: string;
  expiresAt: string;
  issuedAt: string;
  status: "active" | "revoked" | "expired";
}

const ROLE_LABEL: Record<string, string> = { ROLE_CASE_MANAGER: "Case Manager", ROLE_ADMIN: "Admin" };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * The Claude Code command, reading the token from `WORKWELL_MCP_TOKEN` so the token itself never lands in
 * shell history (set it with `read -rs WORKWELL_MCP_TOKEN; export WORKWELL_MCP_TOKEN`, then paste).
 */
export function claudeCodeCommand(issued: Pick<IssuedToken, "mcpUrl">): string {
  return `claude mcp add --transport http workwell ${issued.mcpUrl} --header "Authorization: Bearer $WORKWELL_MCP_TOKEN"`;
}

export function claudeDesktopConfig(issued: Pick<IssuedToken, "mcpUrl" | "token">): string {
  return JSON.stringify(
    {
      workwell: {
        command: "npx",
        args: ["-y", "mcp-remote", issued.mcpUrl, "--transport", "http-only", "--header", "Authorization:${AUTH_HEADER}"],
        env: { AUTH_HEADER: `Bearer ${issued.token}` },
      },
    },
    null,
    2,
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable: the value is selectable on screen */
        }
      }}
    >
      {copied ? "Copied" : `Copy ${label}`}
    </Button>
  );
}

const STATUS_STYLE: Record<TokenRow["status"], string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  revoked: "border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  expired: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
};

export function McpAccessAdmin() {
  const api = useApi();
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<McpRole>("ROLE_CASE_MANAGER");
  const [days, setDays] = useState(30);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<TokenRow | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api.get<{ tokens: TokenRow[] }>("/api/admin/mcp-tokens", { cache: "no-store" });
      setTokens([...body.tokens].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load MCP tokens.");
    }
  }, [api]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const token = await api.post<{ label: string; role: McpRole; days: number }, IssuedToken>("/api/admin/mcp-tokens", { label: label.trim(), role, days });
      setIssued(token);
      setLabel("");
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create the token.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(row: TokenRow) {
    setPendingRevoke(null);
    try {
      await api.delete(`/api/admin/mcp-tokens/${row.tokenId}`);
      if (issued?.tokenId === row.tokenId) setIssued(null);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not revoke the token.");
    }
  }

  return (
    <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm sm:p-6" data-testid="mcp-access">
      <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">mcp access</p>
      <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">MCP tokens and connected clients</h3>
      <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
        A token lets Claude Desktop or Claude Code use WorkWell&apos;s read-only MCP tools as you. It works only on the MCP
        endpoint, never on the rest of the API, and it stops working when you revoke it, when it expires, or when your
        password changes. Tool calls are recorded in the audit log under your name. Clients that support sign-in
        (claude.ai connectors, Claude Code, <code>mcp-remote</code>) can instead connect with no token: they open
        WorkWell to approve, and appear below as connected clients.
      </p>

      <form onSubmit={create} className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <label className="text-sm">
          <span className="block font-medium text-neutral-700 dark:text-neutral-300">Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            required
            placeholder="Claude Desktop on my laptop"
            className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-neutral-700 dark:text-neutral-300">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as McpRole)}
            className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="ROLE_CASE_MANAGER">Case Manager (enough for every tool)</option>
            <option value="ROLE_ADMIN">Admin</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block font-medium text-neutral-700 dark:text-neutral-300">Days valid (1–90)</span>
          <input
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <Button type="submit" disabled={creating || !label.trim()}>
          {creating ? "Creating…" : "Create token"}
        </Button>
      </form>
      {createError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{createError}</p> : null}

      {issued ? (
        <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950" data-testid="mcp-issued">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Copy this token now. It will not be shown again.</p>
          <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">
            &ldquo;{issued.label}&rdquo;, {ROLE_LABEL[issued.role] ?? issued.role}, valid until {day(issued.expiresAt)}. Endpoint: {issued.mcpUrl}
          </p>
          <textarea
            readOnly
            value={issued.token}
            aria-label="MCP token"
            rows={3}
            className="mt-2 w-full resize-none rounded-lg border border-amber-200 bg-white p-2 font-mono text-xs text-neutral-900 dark:border-amber-800 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <CopyButton value={issued.token} label="token" />
            <CopyButton value={claudeCodeCommand(issued)} label="Claude Code command" />
            <CopyButton value={claudeDesktopConfig(issued)} label="Claude Desktop config" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
          <details className="mt-3 text-xs text-amber-900 dark:text-amber-100">
            <summary className="cursor-pointer font-medium">How to use it</summary>
            <p className="mt-2">
              Claude Code: put the token in <code>WORKWELL_MCP_TOKEN</code> without echoing it (<code>read -rs WORKWELL_MCP_TOKEN; export WORKWELL_MCP_TOKEN</code>, then paste), and run
            </p>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-white p-2 font-mono text-[11px] text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">{claudeCodeCommand(issued)}</pre>
            <p className="mt-2">
              Claude Desktop: add this entry under <code>mcpServers</code> in <code>claude_desktop_config.json</code>, then restart Claude Desktop.
            </p>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-white p-2 font-mono text-[11px] text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">{claudeDesktopConfig(issued)}</pre>
          </details>
        </div>
      ) : null}

      <div className="mt-6">
        <h4 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">Issued tokens</h4>
        {loadError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{loadError}</p> : null}
        {tokens === null && !loadError ? <p className="mt-2 text-sm text-neutral-500">Loading…</p> : null}
        {tokens && tokens.length === 0 ? <p className="mt-2 text-sm text-neutral-500">No MCP tokens yet.</p> : null}
        {tokens && tokens.length > 0 ? (
          <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800" data-testid="mcp-token-list">
            {tokens.map((t) => (
              <li key={t.tokenId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                    {t.label || "(no label)"}{" "}
                    <span className="text-xs font-normal text-neutral-500">{t.kind === "oauth" ? "connected client (OAuth)" : "token"}</span>
                  </p>
                  <p className="text-xs text-neutral-500">
                    {[ROLE_LABEL[t.role] ?? t.role, t.subject, t.issuedAt ? `created ${day(t.issuedAt)}` : "issued before the listed history"].filter(Boolean).join(" · ")} ·{" "}
                    {t.status === "expired" ? "expired" : "expires"} {day(t.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[t.status]}`}>{t.status}</span>
                  {t.status === "active" ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setPendingRevoke(t)} aria-label={`Revoke ${t.label}`}>
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <ConfirmDialog
        open={pendingRevoke !== null}
        title="Revoke this MCP token?"
        description={`"${pendingRevoke?.label ?? ""}" stops working on its next request. This cannot be undone; create a new token to reconnect.`}
        confirmLabel="Revoke"
        onConfirm={() => pendingRevoke && void revoke(pendingRevoke)}
        onCancel={() => setPendingRevoke(null)}
      />
    </article>
  );
}
