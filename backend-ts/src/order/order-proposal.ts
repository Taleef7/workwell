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
  // byKey: proposed orders keyed by dedupeKey (allows priority upgrade on same-code collision)
  const byKey = new Map<string, ProposedOrder>();
  const suppressed: ProposedOrder[] = [];
  // suppressedKeys: dedupeKeys covered by a standing order (never upgrade these back to proposed)
  const suppressedKeys = new Set<string>();

  for (const o of outcomes) {
    const priority = AT_RISK[o.status];
    if (!priority) continue; // COMPLIANT / EXCLUDED / unknown → not at risk
    const order = orderForMeasure(o.measureId);
    if (!order) continue; // no action evaluator for this measure
    const dedupeKey = dedupeKeyFor(o.subjectId, order);

    // Standing-order-covered keys stay suppressed regardless of priority.
    if (suppressedKeys.has(dedupeKey)) continue;

    const proposal: ProposedOrder = {
      subjectId: o.subjectId, measureId: o.measureId, order, reasonOutcome: o.status,
      priority, status: "PROPOSED", dedupeKey, authoredOn,
    };

    // In-batch duplicate: same subject + same order code (across ANY measures). By design two
    // measures that map to the SAME order code (e.g. diabetes_hba1c + cms122 → CPT 83036) collapse to
    // ONE proposal for a subject at-risk on both — one order is the correct clinical action, and a
    // duplicate order is exactly what the charter forbids.
    // Priority upgrade: if the incoming row is "urgent" and the existing proposal is "routine",
    // upgrade the existing proposal rather than dropping the higher-severity row.
    const existing = byKey.get(dedupeKey);
    if (existing) {
      if (priority === "urgent" && existing.priority !== "urgent") {
        existing.priority = "urgent";
        existing.reasonOutcome = o.status; // the OVERDUE that drove the upgrade
      }
      continue;
    }

    const covered = standingOrders
      .activeOrdersFor(o.subjectId)
      .some((s) => s.order.code === order.code && s.order.system === order.system);
    if (covered) {
      suppressed.push({ ...proposal, suppressedByStandingOrder: true });
      suppressedKeys.add(dedupeKey);
      continue;
    }
    byKey.set(dedupeKey, proposal);
  }
  return { proposed: [...byKey.values()], suppressed };
}
