/**
 * Programs route (#107 programs module) — the `/programs` dashboard read surface.
 *
 *   GET /api/programs                   overview (alias of /overview, Java parity)   → ProgramSummary[]
 *   GET /api/programs/overview          per-Active-measure KPIs + open case count    → ProgramSummary[]
 *   GET /api/programs/sites             distinct employee sites (global site filter) → string[]
 *   GET /api/programs/:id/trend         per-run compliance trend (newest 10)         → ProgramTrendPoint[]
 *   GET /api/programs/:id/top-drivers   overdue site/role + flagged-reason mix       → TopDrivers
 *   GET /api/programs/:id/risk-outlook  ?horizonDays= predictive outlook             → RiskOutlook | 404
 *
 * Overview/trend/top-drivers honor the page's ?site=&from=&to= filters.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import {
  programOverview,
  programTrend,
  programTopDrivers,
  programRiskOutlook,
  listSites,
  type ProgramDeps,
} from "../program/program-read-models.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";

interface ProgramsEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

async function deps(env: ProgramsEnv): Promise<ProgramDeps> {
  const s = await getStores(env);
  return {
    runStore: s.runs,
    outcomeStore: s.outcomes,
    caseStore: s.cases,
    qualitySnapshots: s.qualitySnapshots,
  };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handlePrograms(req: Request, env: ProgramsEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (req.method !== "GET") return null;

  if (pathname === "/api/programs/sites") {
    return json(listSites());
  }

  // Shared ?site=&tenant=&from=&to= parsing (date filters validated like the Java controller).
  const q = url.searchParams;
  let filters: { site: string | null; tenant: string | null; from?: string; to?: string };
  try {
    filters = { site: q.get("site"), tenant: q.get("tenant"), from: parseQueryDate(q.get("from"), "from"), to: parseQueryDate(q.get("to"), "to") };
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }

  if (pathname === "/api/programs" || pathname === "/api/programs/overview") {
    return json(await programOverview(await deps(env), filters));
  }

  const trendId = pathname.match(/^\/api\/programs\/([^/]+)\/trend$/)?.[1];
  if (trendId) {
    return json(await programTrend(await deps(env), trendId, filters, { monthly: q.get("granularity") === "month" }));
  }

  const driversId = pathname.match(/^\/api\/programs\/([^/]+)\/top-drivers$/)?.[1];
  if (driversId) {
    return json(await programTopDrivers(await deps(env), driversId, filters));
  }

  const riskId = pathname.match(/^\/api\/programs\/([^/]+)\/risk-outlook$/)?.[1];
  if (riskId) {
    const horizonDays = Number(q.get("horizonDays") ?? "30");
    const outlook = await programRiskOutlook(await deps(env), riskId, horizonDays);
    return outlook ? json(outlook) : json({ error: "not_found", message: `Measure not found: ${riskId}` }, 404);
  }

  return null;
}
