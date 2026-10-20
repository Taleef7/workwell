/**
 * The provider × measure quality scorecard (#852).
 *
 *   GET /api/scorecard?measurementYear=YYYY&panel=me|all   → 200 Scorecard | 400
 *
 * CASE_MANAGER and ADMIN only (`auth/authorize.ts`): per-provider rates are the practice's own
 * performance figures, and the read-only VIEWER seat is the public /sandbox and the clinician seat.
 * Aggregates only: no patient identifier leaves this route. The counting is `compliance/scorecard.ts`.
 */
import { getStores } from "../stores/factory.ts";
import type { CloudDatabase, CloudBucket } from "@mieweb/cloud";
import { employeeById, providerById, isRunnableMeasure, DIRECTORY } from "../config/deployment-profile.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { profileForId } from "../engine/ingress/webchart/live-directory.ts";
import { providerIdsOwnedBy } from "../case/panel-assignment.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { isOfficialRouted } from "../wiring/official-routing.ts";
import { buildScorecard } from "../compliance/scorecard.ts";

export interface ScorecardEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  BUCKET?: CloudBucket;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleScorecard(
  req: Request,
  env: ScorecardEnv,
  actor = "system",
  clock: () => Date = () => new Date(),
): Promise<Response | null> {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== "/api/scorecard") return null;
  const q = url.searchParams;
  const now = clock();
  const today = now.toISOString().slice(0, 10);

  // The year defaults to the current one, unlike the attributed-list report: that report is a file the
  // ACO keeps for a year, while this page opens on what the practice is working now and says which year.
  const rawYear = q.get("measurementYear")?.trim() || today.slice(0, 4);
  const measurementYear = Number(rawYear);
  if (!/^\d{4}$/.test(rawYear)) {
    return json({ error: "invalid_request", parameter: "measurementYear", message: "measurementYear must be a four-digit year" }, 400);
  }
  const panel = q.get("panel")?.trim().toLowerCase() || "all";
  if (panel !== "me" && panel !== "all") {
    return json({ error: "invalid_request", parameter: "panel", message: "panel must be me or all" }, 400);
  }

  const stores = await getStores(env);
  // "My providers" is resolved from the panel MAPPINGS and the caller's identity (ADR-080 d5), never from
  // a client-supplied list, as `/api/worklist/patients` resolves "My panel".
  const owned = providerIdsOwnedBy(await stores.panels.listAll(), actor);
  const employeeLookup = isWebChartConfigured(env)
    ? (externalId: string) => employeeById(externalId) ?? profileForId(externalId, DIRECTORY)
    : employeeById;

  const scorecard = await buildScorecard(
    {
      outcomes: stores.outcomes,
      runs: stores.runs,
      events: stores.events,
      cases: stores.cases,
      subjectOf: employeeLookup,
      // The scoped lookup, with the env: on a deployment showing the live WebChart tenant, its patients'
      // PCP is that tenant's provider, which the static list does not hold.
      providerOf: (id) => providerById(id, env),
    },
    {
      measurementYear,
      // The attributed-list report's set: runnable and official-routed, the measures with populations.
      measures: MEASURE_CATALOG.filter((m) => m.status === "Active" && isRunnableMeasure(m.id) && isOfficialRouted(m.id)),
      providerIds: panel === "me" ? new Set(owned) : null,
      ownsPanel: owned.length > 0,
      today,
      now: now.toISOString(),
    },
  );
  return json(scorecard);
}
