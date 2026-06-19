/**
 * Order proposals route (#77 E7) — advisory "Action Evaluators → orders" over the latest population
 * run per Active measure. Read-time; no schema. Gated to CASE_MANAGER/ADMIN by the auth matrix
 * (orders are clinical). format=domain (default) → {proposed,suppressed}; format=fhir → ServiceRequest Bundle.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { isPopulationRun, latestRunRows } from "../program/rollup-shared.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";
import { proposeOrders, type AtRiskOutcome } from "../order/order-proposal.ts";
import { resolveStandingOrderProvider, type StandingOrderEnv } from "../order/standing-order-provider.ts";
import { bundleOf } from "../order/proposed-order.ts";

interface OrdersEnv extends StandingOrderEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleOrders(req: Request, env: OrdersEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/orders/proposals") return null;

  const q = url.searchParams;
  let from: string | undefined;
  let to: string | undefined;
  try {
    from = parseQueryDate(q.get("from"), "from");
    to = parseQueryDate(q.get("to"), "to");
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }
  const measureId = q.get("measureId")?.trim() || null;
  const subjectId = q.get("subjectId")?.trim() || null;
  const fhir = (q.get("format") ?? "domain") === "fhir";

  const active = MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id);
  const scope = measureId ? (active.includes(measureId) ? [measureId] : []) : active;

  const s = await getStores(env);
  const atRisk: AtRiskOutcome[] = [];
  if (scope.length > 0) {
    const all = (await s.outcomes.listOutcomesWithRun({ from, to })).filter((r) => isPopulationRun(r.runScopeType));
    const byMeasure = new Map<string, typeof all>();
    for (const r of all) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
    for (const m of scope) {
      for (const r of latestRunRows(byMeasure.get(m) ?? [])) {
        if (subjectId && r.subjectId !== subjectId) continue;
        atRisk.push({ subjectId: r.subjectId, measureId: r.measureId, status: r.status });
      }
    }
  }
  const { proposed, suppressed } = proposeOrders(atRisk, resolveStandingOrderProvider(env));
  // FHIR output carries only `proposed` — a standing-order-suppressed item must NOT emit a duplicate
  // ServiceRequest (the charter's "duplicate orders are bad"). The domain view returns both so callers
  // can see why an at-risk member got no order.
  return fhir ? json(bundleOf(proposed)) : json({ proposed, suppressed });
}
