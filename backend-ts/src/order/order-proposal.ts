/**
 * Order proposal engine (#77 E7) — trigger-agnostic + pure. Panel=Risk: the at-risk gap
 * (Denominator − Numerator = OVERDUE|DUE_SOON|MISSING_DATA) gets a proposed order; COMPLIANT/EXCLUDED
 * don't. Risk tier → priority. Deduped in-batch and against the StandingOrderProvider (the charter's
 * "duplicate orders are bad"). Read-time today (the orders route); the SAME function is
 * run-pipeline-callable when EH auto-ordering is wired.
 */
import { dedupeKeyFor, type ChoiceProposal, type OrderPriority, type ProposedOrder } from "./proposed-order.ts";
import { codeKey, ordersForMeasure } from "./order-catalog.ts";
import { orderApplicability } from "./order-applicability.ts";
import type { StandingOrderProvider } from "./standing-order-provider.ts";
import { practiceToday } from "../config/practice-date.ts";

/** Minimal input shape (decoupled from OutcomeWithRun): the route maps outcomes → these. */
export interface AtRiskOutcome {
  subjectId: string;
  measureId: string;
  status: string;
  /**
   * The outcome's evidence (with `cqlFacts`), read by `orderApplicability` for a measure whose order is
   * offered only when CQL found nothing (cms122, cms2, cms165, cms137). Without it such a measure offers
   * nothing: "we cannot tell" never becomes "order it".
   */
  evidence?: unknown;
  outOfPopulation?: boolean;
}

export interface OrderProposals {
  proposed: ProposedOrder[];
  suppressed: ProposedOrder[];
  /** Choice measures' open gaps (#640 item 3): options only, never an order. */
  choices: ChoiceProposal[];
  /** Choice gaps withheld because an option is already on a standing order. */
  suppressedChoices: ChoiceProposal[];
}

const AT_RISK: Record<string, OrderPriority | undefined> = {
  OVERDUE: "urgent",
  DUE_SOON: "routine",
  MISSING_DATA: "routine",
};

export function proposeOrders(
  outcomes: AtRiskOutcome[],
  standingOrders: StandingOrderProvider,
  authoredOn: string = practiceToday(),
): OrderProposals {
  // byKey: proposed orders keyed by dedupeKey (allows priority upgrade on same-code collision)
  const byKey = new Map<string, ProposedOrder>();
  const suppressed: ProposedOrder[] = [];
  // suppressedKeys: dedupeKeys covered by a standing order (never upgrade these back to proposed)
  const suppressedKeys = new Set<string>();

  const choiceRows: Array<{ o: AtRiskOutcome; priority: OrderPriority }> = [];
  for (const o of outcomes) {
    const priority = AT_RISK[o.status];
    if (!priority) continue; // COMPLIANT / EXCLUDED / unknown → not at risk
    const orders = ordersForMeasure(o.measureId);
    if (!orders) continue; // no action evaluator for this measure
    // Only a gap an order could close (nothing qualifying found): never a result that is not controlled.
    if (!orderApplicability(o.measureId, o).applies) continue;
    if (orders.mode === "choice") {
      choiceRows.push({ o, priority }); // after every protocol row, so a protocol order claims its code first
      continue;
    }
    const { code, system, display } = orders.options[0]!;
    const order = { code, system, display };
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

  // Choice rows: each option claims its own key. An option a protocol row (or an earlier choice) already
  // claimed is dropped, so one order is never offered twice for a subject; a row left with no option is
  // covered and drops. One option already on a standing order withholds the whole choice: the screening
  // is under way, and offering a different test beside it would be the duplicate the charter forbids.
  const choices: ChoiceProposal[] = [];
  const suppressedChoices: ChoiceProposal[] = [];
  const choiceClaimed = new Set<string>();
  for (const { o, priority } of choiceRows) {
    const options = ordersForMeasure(o.measureId)!.options;
    const row: ChoiceProposal = {
      subjectId: o.subjectId, measureId: o.measureId, reasonOutcome: o.status, priority, optionKeys: [], authoredOn,
    };
    const standing = standingOrders.activeOrdersFor(o.subjectId);
    if (options.some((opt) => standing.some((s) => s.order.code === opt.code && s.order.system === opt.system))) {
      suppressedChoices.push({ ...row, optionKeys: options.map(codeKey) });
      continue;
    }
    for (const opt of options) {
      const key = dedupeKeyFor(o.subjectId, opt);
      if (byKey.has(key) || suppressedKeys.has(key) || choiceClaimed.has(key)) continue;
      choiceClaimed.add(key);
      row.optionKeys.push(codeKey(opt));
    }
    if (row.optionKeys.length > 0) choices.push(row);
  }
  return { proposed: [...byKey.values()], suppressed, choices, suppressedChoices };
}
