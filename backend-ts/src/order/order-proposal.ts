/**
 * Order proposal engine (#77 E7) — trigger-agnostic + pure. Panel=Risk: the at-risk gap
 * (Denominator − Numerator = OVERDUE|DUE_SOON|MISSING_DATA) gets a proposed order; COMPLIANT/EXCLUDED
 * don't. Risk tier → priority. Deduped in-batch and against the StandingOrderProvider (the charter's
 * "duplicate orders are bad"). Read-time today (the orders route); the SAME function is
 * run-pipeline-callable when EH auto-ordering is wired.
 */
import { dedupeKeyFor, type OrderPriority, type ProposedOrder } from "./proposed-order.ts";
import { orderForMeasure } from "./order-catalog.ts";
import type { StandingOrderProvider } from "./standing-order-provider.ts";

/** Minimal input shape (decoupled from OutcomeWithRun): the route maps outcomes → these. */
export interface AtRiskOutcome {
  subjectId: string;
  measureId: string;
  status: string;
}

const AT_RISK: Record<string, OrderPriority | undefined> = {
  OVERDUE: "urgent",
  DUE_SOON: "routine",
  MISSING_DATA: "routine",
};

export function proposeOrders(
  outcomes: AtRiskOutcome[],
  standingOrders: StandingOrderProvider,
  authoredOn: string = new Date().toISOString().slice(0, 10),
): { proposed: ProposedOrder[]; suppressed: ProposedOrder[] } {
  const proposed: ProposedOrder[] = [];
  const suppressed: ProposedOrder[] = [];
  const seen = new Set<string>(); // in-batch dedupe keys already proposed

  for (const o of outcomes) {
    const priority = AT_RISK[o.status];
    if (!priority) continue; // COMPLIANT / EXCLUDED / unknown → not at risk
    const order = orderForMeasure(o.measureId);
    if (!order) continue; // no action evaluator for this measure
    const dedupeKey = dedupeKeyFor(o.subjectId, order);
    const proposal: ProposedOrder = {
      subjectId: o.subjectId, measureId: o.measureId, order, reasonOutcome: o.status,
      priority, status: "PROPOSED", dedupeKey, authoredOn,
    };
    if (seen.has(dedupeKey)) continue; // in-batch duplicate
    const covered = standingOrders
      .activeOrdersFor(o.subjectId)
      .some((s) => s.order.code === order.code && s.order.system === order.system);
    if (covered) {
      suppressed.push({ ...proposal, suppressedByStandingOrder: true });
      seen.add(dedupeKey);
      continue;
    }
    proposed.push(proposal);
    seen.add(dedupeKey);
  }
  return { proposed, suppressed };
}
