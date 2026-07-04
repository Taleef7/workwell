/**
 * Compliance roster route (E10.2) — the "Individual Compliance Status" grid behind the unchanged
 * frontend contract. Authenticated read-only under the /api/** matrix (all roles), like
 * /api/hierarchy/rollup.
 *
 *   GET /api/compliance/roster?panel=&status=&site=&role=&q=&segment=&tenant=&page=&pageSize=
 *     → { panel, columns, rows }  + X-Total-Count header (full filtered match count)
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { buildRoster, rosterCellCache } from "../compliance/roster-read-model.ts";
import { isPanelId } from "../compliance/panels.ts";
import { ensureSegmentSeed } from "../segment/segment-seed.ts";

interface ComplianceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const intOr = (v: string | null, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export async function handleCompliance(req: Request, env: ComplianceEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/compliance/roster") return null;

  const q = url.searchParams;
  // A present-but-unknown panel is a client error (Fable L24) — 400, matching the roster's own 400s on
  // malformed dates/scopeLevel. An omitted panel still defaults (immunizations) in the read model.
  const panelParam = q.get("panel");
  if (panelParam !== null && !isPanelId(panelParam)) {
    return json({ error: "invalid_request", message: `unknown panel '${panelParam}' (expected immunizations | osha | wellness)` }, 400);
  }
  await ensureSegmentSeed(env);
  const stores = await getStores(env);
  const segments = await stores.segments.listSegments();
  const roster = await buildRoster(
    { outcomeStore: stores.outcomes, segments, cellCache: rosterCellCache },
    {
      panel: q.get("panel"),
      status: q.get("status"),
      site: q.get("site"),
      role: q.get("role"),
      q: q.get("q"),
      segment: q.get("segment"),
      tenant: q.get("tenant"),
      page: intOr(q.get("page"), 1),
      pageSize: intOr(q.get("pageSize"), 50),
    },
  );
  return json(
    { panel: roster.panel, columns: roster.columns, rows: roster.rows },
    200,
    { "X-Total-Count": String(roster.total) },
  );
}
