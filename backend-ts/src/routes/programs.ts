/**
 * Programs route (#107 programs module) — the `/programs` dashboard read surface.
 *
 *   GET /api/programs                   overview (alias of /overview, Java parity)   → ProgramSummary[]
 *   GET /api/programs/overview          per-Active-measure KPIs + open case count    → ProgramSummary[]
 *     ?include=detail&granularity=&tz=  each summary additionally carries `trend` + `topDrivers`
 *   GET /api/programs/sites             distinct employee sites (global site filter) → string[]
 *   GET /api/programs/:id/trend         per-run compliance trend (newest 10)         → ProgramTrendPoint[]
 *   GET /api/programs/:id/top-drivers   overdue site/role + flagged-reason mix       → TopDrivers
 *   GET /api/programs/:id/risk-outlook  ?horizonDays= predictive outlook             → RiskOutlook | 404
 *
 * Overview/trend/top-drivers honor the page's ?site=&from=&to= filters.
 *
 * `?include=detail` exists because the dashboard needs all three for every measure at once: it was
 * making 1 + 2N requests (13 on the pilot), each re-resolving the same winning runs and re-reading
 * the same directory, and a single-process worker serialises them anyway — so the fan-out bought
 * concurrency it could not spend and paid for it in repeated work. The per-measure routes stay: they
 * are the drill-down surface, and dropping them would break a deep link. The `trend`/`topDrivers`
 * fields are ADDITIVE — the response is the same `ProgramSummary[]` either way — so a client that
 * does not ask keeps the response it has.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import {
  programOverview,
  programTrend,
  programTopDrivers,
  programRiskOutlook,
  programSites,
  type ProgramDeps,
} from "../program/program-read-models.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";

interface ProgramsEnv extends DataSourceEnv {
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
    webChartEnv: env,
  };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handlePrograms(req: Request, env: ProgramsEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (req.method !== "GET") return null;

  if (pathname === "/api/programs/sites") {
    return json(await programSites(await deps(env)));
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
    const d = await deps(env);
    const summaries = await programOverview(d, filters);
    if (q.get("include") !== "detail") return json(summaries);
    // Sequential, and NOT because these are memo hits — `programOverview` fills only its own memo,
    // so on a cold process every one of these is a real read. Sequential because they are reads of
    // the same winning runs on a single-process worker: running them together interleaves the misses
    // and multiplies peak memory without finishing sooner.
    //
    // Per-measure failure isolation is the point of the try/catch. These used to be N separate
    // client requests, each with its own `catch` that degraded to an empty panel; folded into one
    // response, an unhandled throw from a single measure's drivers would 500 the whole dashboard.
    const monthly = q.get("granularity") === "month";
    const tz = q.get("tz") ?? undefined;
    const detailed = [];
    for (const summary of summaries) {
      let trend: Awaited<ReturnType<typeof programTrend>> = [];
      let topDrivers: Awaited<ReturnType<typeof programTopDrivers>> = { bySite: [], byRole: [], byOutcomeReason: [] };
      try {
        trend = await programTrend(d, summary.measureId, filters, { monthly, tz });
      } catch (err) {
        console.warn(`[workwell] trend failed for ${summary.measureId}: ${String((err as Error)?.message ?? err)}`);
      }
      try {
        topDrivers = await programTopDrivers(d, summary.measureId, filters);
      } catch (err) {
        console.warn(`[workwell] top-drivers failed for ${summary.measureId}: ${String((err as Error)?.message ?? err)}`);
      }
      detailed.push({ ...summary, trend, topDrivers });
    }
    return json(detailed);
  }

  const trendId = pathname.match(/^\/api\/programs\/([^/]+)\/trend$/)?.[1];
  if (trendId) {
    return json(
      await programTrend(await deps(env), trendId, filters, {
        monthly: q.get("granularity") === "month",
        tz: q.get("tz") ?? undefined,
      }),
    );
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
