/**
 * MCP access tokens, minted and revoked by an admin (#704). ADMIN only, through the `/api/admin/**` rule.
 *
 *   POST   /api/admin/mcp-tokens        { label, role?, days? } → the token, ONCE, for the caller
 *   GET    /api/admin/mcp-tokens        → issued tokens with their status (never a token)
 *   DELETE /api/admin/mcp-tokens/{id}   → revoke one
 *
 * - **For the caller only.** `sub` is the admin who mints it, so the tools' audit actor and the per-tool
 *   role gates are that person's; the token may carry their role or the lower Case Manager one (the
 *   default, least privilege).
 * - **Audit-first.** `MCP_TOKEN_ISSUED` is written before the revocation row that makes the token valid, and
 *   `MCP_TOKEN_REVOKED` before the row is deleted; neither payload ever holds the token. A ledger write that
 *   fails issues or revokes nothing.
 * - **Fails closed.** A store error answers 503 and issues nothing; so does a missing or bad
 *   `WORKWELL_PUBLIC_API_URL`, since the token's audience is built from it.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores, type StoresEnv } from "../stores/factory.ts";
import { credentialVersion, findDemoUser } from "../auth/demo-users.ts";
import { PAT_FAMILY_PREFIX, PAT_MAX_DAYS, isMcpRole, issuePat, roleWithin, type McpRole } from "../auth/mcp-token.ts";
import { mcpResourceOf, publicApiUrl } from "../config/public-api-url.ts";

interface Env extends StoresEnv {
  DB: CloudDatabase;
  WORKWELL_AUTH_JWT_SECRET?: string;
  WORKWELL_PUBLIC_API_URL?: string;
}

const BASE = "/api/admin/mcp-tokens";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL_MAX = 60;
const DEFAULT_DAYS = 30;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
/** A configuration problem: our own message, safe to show. */
const misconfigured = (reason: string) => json({ error: "mcp_tokens_unavailable", reason }, 503);
/** A store or ledger failure: logged here, never returned (an error's text can carry internals). */
const storeDown = (err: unknown) => {
  console.error(`[workwell] MCP token store unavailable: ${String((err as Error)?.message ?? err)}`);
  return json({ error: "mcp_tokens_unavailable", reason: "the token store is unavailable; try again" }, 503);
};

interface IssuedEvent {
  tokenId: string;
  label: string;
  role: string;
  subject: string;
  expiresAt: string;
  issuedAt: string;
}

export type McpTokenStatus = "active" | "revoked" | "expired";

async function issuedTokens(env: Env): Promise<IssuedEvent[]> {
  const { events } = await getStores(env);
  return (await events.recentAuditEventsByType("MCP_TOKEN_ISSUED", 500)).flatMap((e) => {
    const p = e.payload as Partial<IssuedEvent>;
    return typeof p.tokenId === "string" && typeof p.expiresAt === "string"
      ? [{ tokenId: p.tokenId, label: String(p.label ?? ""), role: String(p.role ?? ""), subject: String(p.subject ?? ""), expiresAt: p.expiresAt, issuedAt: e.occurredAt }]
      : [];
  });
}

/** Returns a Response if this module owns the route, else null. `actor` is the signed-in admin. */
export async function handleAdminMcpTokens(req: Request, env: Env, actor: string, authEnabled: boolean): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;
  if (!authEnabled) return json({ error: "auth_disabled", message: "MCP tokens need WORKWELL_AUTH_JWT_SECRET" }, 404);

  if (pathname === BASE && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { label?: unknown; role?: unknown; days?: unknown } | null;
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!label || label.length > LABEL_MAX) return json({ error: "invalid_label", message: `label is 1–${LABEL_MAX} characters` }, 400);
    const role = body?.role ?? "ROLE_CASE_MANAGER";
    const days = body?.days ?? DEFAULT_DAYS;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > PAT_MAX_DAYS) {
      return json({ error: "invalid_days", message: `days is a whole number from 1 to ${PAT_MAX_DAYS}` }, 400);
    }
    const user = findDemoUser(actor);
    if (!user) return json({ error: "unknown_account" }, 403);
    if (!isMcpRole(role) || !roleWithin(role, user.role)) {
      return json({ error: "invalid_role", message: "role is ROLE_CASE_MANAGER or ROLE_ADMIN, and not above your own" }, 400);
    }
    const pub = publicApiUrl(env, req, true);
    if (!pub.ok) return misconfigured(pub.reason);
    const mcpUrl = mcpResourceOf(pub.origin);

    const pat = issuePat(env.WORKWELL_AUTH_JWT_SECRET ?? "", { subject: user.email, role: role as McpRole, cv: credentialVersion(user), resource: mcpUrl, days });
    try {
      const { events, authFamilies } = await getStores(env);
      // AUDIT BEFORE THE ROW THAT MAKES THE TOKEN VALID (#704): a failure here issues nothing.
      await events.appendAudit({
        eventType: "MCP_TOKEN_ISSUED",
        entityType: "mcp_token",
        entityId: pat.tokenId,
        actor,
        refRunId: null,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: { tokenId: pat.tokenId, label, role, subject: user.email, expiresAt: pat.expiresAt },
      });
      await authFamilies.rotate(pat.family, pat.jti, pat.expiresAt, new Date().toISOString());
    } catch (err) {
      return storeDown(err);
    }
    return json({ token: pat.token, tokenId: pat.tokenId, label, role, subject: user.email, expiresAt: pat.expiresAt, mcpUrl }, 201);
  }

  if (pathname === BASE && req.method === "GET") {
    try {
      const { authFamilies } = await getStores(env);
      const now = new Date();
      // The row decides: a token is active while its row lives, whatever events say (a revoke whose
      // delete failed leaves the event and a working token, which must still show as active to be
      // revoked again). Events add the label and owner, and the history of tokens no longer live.
      const live = new Map(
        (await authFamilies.listByPrefix(PAT_FAMILY_PREFIX, now.toISOString())).map((r) => [r.family.slice(PAT_FAMILY_PREFIX.length), r.expiresAt]),
      );
      const issued = await issuedTokens(env);
      const tokens: Array<IssuedEvent & { status: McpTokenStatus }> = issued.map((t) => ({
        ...t,
        // Expired first: a lapsed row is purged, so a missing row means "revoked" only before the expiry.
        status: live.has(t.tokenId) ? "active" : Date.parse(t.expiresAt) <= now.getTime() ? "expired" : "revoked",
      }));
      // A live token whose issue event is older than the scan above is still listed, so it can be revoked.
      const seen = new Set(issued.map((t) => t.tokenId));
      for (const [tokenId, expiresAt] of live) {
        if (!seen.has(tokenId)) tokens.push({ tokenId, label: "", role: "", subject: "", expiresAt, issuedAt: "", status: "active" });
      }
      return json({ tokens });
    } catch (err) {
      return storeDown(err);
    }
  }

  const id = pathname.slice(BASE.length + 1);
  if (req.method === "DELETE" && UUID.test(id)) {
    try {
      const { events, authFamilies } = await getStores(env);
      // Revocable while its row lives, found by id, so no audit scan limit can hide a working token.
      if ((await authFamilies.currentJti(`${PAT_FAMILY_PREFIX}${id}`, new Date().toISOString())) === null) {
        return json({ error: "not_found", message: "no active MCP token with this id" }, 404);
      }
      const issued = (await issuedTokens(env)).find((t) => t.tokenId === id);
      // AUDIT BEFORE THE DELETE (#704): the ledger never misses a revocation that happened.
      await events.appendAudit({
        eventType: "MCP_TOKEN_REVOKED",
        entityType: "mcp_token",
        entityId: id,
        actor,
        refRunId: null,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: { tokenId: id, label: issued?.label ?? null, subject: issued?.subject ?? null },
      });
      await authFamilies.revoke(`${PAT_FAMILY_PREFIX}${id}`);
    } catch (err) {
      return storeDown(err);
    }
    return new Response(null, { status: 204 });
  }

  return json({ error: "not_found" }, 404);
}
