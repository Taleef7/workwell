/**
 * The provider × measure quality scorecard (#852).
 *
 *   GET /api/scorecard?measurementYear=YYYY&panel=me|all   → 200 Scorecard | 400 | 403
 *
 * CASE_MANAGER and ADMIN read the practice card: per-provider rates are the practice's own performance
 * figures. Every other role is refused, except a clinician seat linked to a provider (#870), which reads
 * that provider's row beside the practice total and nothing else; the read-only VIEWER that is the public
 * /sandbox carries no link and is refused. The decision is made first, before any parameter or store is
 * read, and it allows by role rather than refusing by role, so widening the authorize rule never hands
 * the practice card to a new role, nor to a caller with no role at all: that one reads the practice card
 * only where auth is turned off, which the worker says rather than this route inferring it from a missing
 * role. Aggregates only: no patient identifier leaves this route. The counting is `compliance/scorecard.ts`.
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
import { linkedProviderOf } from "./providers.ts";

export interface ScorecardEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  BUCKET?: CloudBucket;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** The roles that read the whole practice's card. */
const PRACTICE_ROLES: ReadonlySet<string> = new Set(["ROLE_CASE_MANAGER", "ROLE_ADMIN"]);

export async function handleScorecard(
  req: Request,
  env: ScorecardEnv,
  actor: string,
  principalRole: string | null,
  /** Whether the worker enforces sign-in. Only where it does not is a caller with no role the practice's. */
  authEnforced: boolean,
  clock: () => Date = () => new Date(),
): Promise<Response | null> {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== "/api/scorecard") return null;
  // Which card, before anything else: an unlinked seat costs nothing and always gets 403, never a 400 that
  // says which parameters exist.
  const practice = authEnforced ? principalRole !== null && PRACTICE_ROLES.has(principalRole) : true;
  const linked = authEnforced && principalRole === "ROLE_VIEWER" ? linkedProviderOf(actor, env) : null;
  if (!practice && !linked) {
    return json({ error: "forbidden", reason: "no_linked_provider", message: "this sign-in is not linked to a provider" }, 403);
  }
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
  // a client-supplied list, as `/api/worklist/patients` resolves "My panel". A clinician seat owns no
  // panel and its card is its own row, so `panel` (validated above) changes nothing for it.
  const owned = linked ? [] : providerIdsOwnedBy(await stores.panels.listAll(), actor);
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
      providerIds: !linked && panel === "me" ? new Set(owned) : null,
      onlyProvider: linked?.id ?? null,
      ownsPanel: owned.length > 0,
      today,
      now: now.toISOString(),
    },
  );
  return json(scorecard);
}
