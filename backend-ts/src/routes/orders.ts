/**
 * Order proposals route (#77 E7) — advisory "Action Evaluators → orders" over the latest population
 * run per Active measure. Read-time; no schema. Gated to CASE_MANAGER/ADMIN by the auth matrix
 * (orders are clinical). format=domain (default) → {proposed, suppressed, totals}, optionally windowed
 * by ?limit=1..1000&offset= (both lists, same window; totals are the pre-window counts; proposals are
 * in (subject, measure) order); format=fhir → ServiceRequest Bundle of every proposed order, never windowed.
 *
 * A subject the measure's own logic put OUTSIDE its initial population is not at risk and gets no
 * proposal (#546, owner decision). ADR-078 settled that such a subject is a result and not a CASE;
 * it did not say what they are for an ORDER, and the answer chosen is to read the population
 * membership the run persisted (`out_of_population`, ADR-079) and skip them. The alternative —
 * deriving proposals from active cases — would have let a human closing a case silently withdraw a
 * clinical order. Until this, `MISSING_DATA` alone made every non-diabetic eligible for an HbA1c and
 * every man for a mammogram: 33,963 proposals for a 20,000-patient roster.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { isCompletedRun, isPopulationRun, latestRunRows } from "../program/rollup-shared.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";
import { proposeOrders, type AtRiskOutcome } from "../order/order-proposal.ts";
import { resolveStandingOrderProvider, type StandingOrderEnv } from "../order/standing-order-provider.ts";
import { bundleOf } from "../order/proposed-order.ts";
import { DEPLOYMENT_PROFILE, isRunnableMeasure } from "../config/deployment-profile.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";
import { latestPopulationSnapshot } from "../program/latest-population.ts";

interface OrdersEnv extends StandingOrderEnv, DataSourceEnv {
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
  // Optional window over the domain view (the page shows 100 at a time; the pilot proposes ~34,000).
  // Absent → the full arrays, as before. Malformed → 400, like the date filters: a page served under
  // a heading that says "page 3" must be page 3.
  const limitRaw = q.get("limit");
  const offsetRaw = q.get("offset");
  // Decimal digits only: `Number()` would also admit "0x10" and "1e2", which a client never means.
  const digits = (s: string | null): number | null => (s !== null && /^\d{1,7}$/.test(s) ? Number(s) : null);
  const limit = limitRaw === null ? null : digits(limitRaw);
  const offset = offsetRaw === null ? 0 : digits(offsetRaw);
  if ((limitRaw !== null && (limit === null || limit < 1 || limit > 1000)) || offset === null) {
    return json({ error: "invalid_request", message: "limit must be an integer 1..1000 and offset a non-negative integer" }, 400);
  }

  const active = MEASURE_CATALOG.filter((m) => m.status === "Active" && isRunnableMeasure(m.id)).map((m) => m.id);
  const scope = measureId ? (active.includes(measureId) ? [measureId] : []) : active;

  const s = await getStores(env);
  const atRisk: AtRiskOutcome[] = [];
  if (scope.length > 0) {
    // The latest live population run per scoped measure, read by run id (`latestPopulationSnapshot`)
    // — not every retained run's rows reduced in JS, which this route did on every profile until
    // 2026-09-10 (the pilot's ~1M rows to keep 120,000). excludeScale keeps the generated scale
    // tenant out in SQL (E13 PR-2 — bounded + never proposes for it). The trend-history seed is NOT
    // excluded, as it never was here: under a `from`/`to` window a seeded run can be the newest
    // inside the window, and this route's answer must not change with the read path.
    const snap = await latestPopulationSnapshot(s.outcomes, scope, { from, to, excludeScale: true }, env);
    const all = snap.rows.filter((r) => isPopulationRun(r.runScopeType) && isCompletedRun(r.runStatus));
    const visibleRows = DEPLOYMENT_PROFILE.id === "default" ? all : all.filter((r) => snap.profileMatch(r.subjectId));
    const byMeasure = new Map<string, typeof all>();
    for (const r of visibleRows) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
    for (const m of scope) {
      for (const r of latestRunRows(byMeasure.get(m) ?? [])) {
        if (subjectId && r.subjectId !== subjectId) continue;
        // A subject the measure's own logic put OUTSIDE its initial population is not at risk of
        // anything (#546). Read from the persisted flag (ADR-079) rather than the status, which
        // since ADR-078 records them as MISSING_DATA and so made every non-diabetic eligible for an
        // HbA1c and every man for a mammogram: 33,963 proposals for a 20,000-patient roster.
        if (r.outOfPopulation === true && r.status === "MISSING_DATA") continue;
        atRisk.push({ subjectId: r.subjectId, measureId: r.measureId, status: r.status });
      }
    }
    // A page is only a page if the order underneath it is stable: the store's read carries no ORDER
    // BY, so `proposeOrders` (which keeps input order, and dedupes cross-measure orders to the FIRST
    // measure seen) is fed (subject, measure) order. That also makes the dedupe winner deterministic.
    atRisk.sort((a, b) => a.subjectId.localeCompare(b.subjectId) || a.measureId.localeCompare(b.measureId));
  }
  const { proposed, suppressed } = proposeOrders(atRisk, resolveStandingOrderProvider(env));
  // FHIR output carries only `proposed` — a standing-order-suppressed item must NOT emit a duplicate
  // ServiceRequest (the charter's "duplicate orders are bad") — and is never windowed: it is the
  // bundle a clinician copies whole. The domain view returns both so callers can see why an at-risk
  // member got no order, windowed when asked, with the full counts alongside either way.
  if (fhir) return json(bundleOf(proposed));
  const totals = { proposed: proposed.length, suppressed: suppressed.length };
  const page = <T>(xs: T[]): T[] => (limit === null ? xs : xs.slice(offset, offset + limit));
  return json({ proposed: page(proposed), suppressed: page(suppressed), totals });
}
