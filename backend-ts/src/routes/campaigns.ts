/**
 * Campaigns route (#75 E5) — batch outreach campaigns. Authenticated under /api/** by the worker
 * security matrix; the actor comes from the auth middleware (never the request body).
 *
 *   POST /api/campaigns        body: CampaignRequest (+ ?dryRun=true) → CampaignResult
 *   GET  /api/campaigns                                               → CampaignRecord[] (newest-first)
 *   GET  /api/campaigns/:id                                           → { campaign, recipients } | 404
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { runCampaign, listCampaigns, getCampaignDetail, CampaignError, type CampaignDeps, type CampaignRequest } from "../case/outreach-campaign.ts";
import { resolveChannel, type ChannelType, type ChannelEnv } from "../case/outreach-channel.ts";

interface CampaignsEnv extends ChannelEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function deps(env: CampaignsEnv): Promise<CampaignDeps> {
  const s = await getStores(env);
  return {
    cases: s.cases, events: s.events, outcomes: s.outcomes, campaigns: s.campaigns,
    channels: (type: ChannelType) => resolveChannel(type, env),
  };
}

export async function handleCampaigns(req: Request, env: CampaignsEnv, actor: string): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (!pathname.startsWith("/api/campaigns")) return null;

  if (req.method === "POST" && pathname === "/api/campaigns") {
    const body = (await req.json().catch(() => ({}))) as Partial<CampaignRequest>;
    const dryRun = body.dryRun ?? url.searchParams.get("dryRun") === "true";
    try {
      const result = await runCampaign(await deps(env), { ...body, channel: body.channel as ChannelType, dryRun } as CampaignRequest, actor);
      return json(result);
    } catch (err) {
      if (err instanceof CampaignError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }

  if (req.method === "GET" && pathname === "/api/campaigns") {
    return json(await listCampaigns(await deps(env)));
  }

  const id = req.method === "GET" ? pathname.match(/^\/api\/campaigns\/([^/]+)$/)?.[1] : undefined;
  if (id) {
    const detail = await getCampaignDetail(await deps(env), id);
    return detail ? json(detail) : json({ error: "not_found", message: `Campaign not found: ${id}` }, 404);
  }

  return null;
}
