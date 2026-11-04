/**
 * Whether an order could close this outcome's gap (#620, #640; owner decision 2026-11-04).
 *
 * An order is offered only when the measure's own CQL found nothing qualifying. A result that is not
 * controlled, a screening that does not count yet, or a missed engagement is not fixed by ordering again,
 * and a card or a case page saying "order X" would state a clinical action the outcome does not support
 * (AI_GUARDRAILS §1.1). So this reads what CQL found, through THE reader the case page and the list report
 * already share (`cqlFindingsOf`, #875/#880), and adds no interpretation of its own: no value is read, no
 * date is compared, no age is computed.
 *
 * When the run recorded nothing a reader can name (authored CQL, a run before #875, an errored row), no
 * order is offered for an evidence-ruled measure: "we cannot tell" never becomes "order it".
 */
import { cqlFindingsOf } from "../case/case-findings.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { ordersForMeasure } from "./order-catalog.ts";

export type Applicability = { applies: true } | { applies: false; reason: string };

export interface ApplicabilityInput {
  status: string;
  evidence?: unknown;
  outOfPopulation?: boolean;
}

/** The statuses an open gap carries; the same set `order-proposal.ts` gives a priority. */
export const AT_RISK_STATUSES: ReadonlySet<string> = new Set(["OVERDUE", "DUE_SOON", "MISSING_DATA"]);

const SEE_NEXT = "See the next action.";
const FOUND_REASON: Record<string, string> = {
  cms122: `A result was found this period, and CQL counts it as not controlled. ${SEE_NEXT}`,
  cms165: `A blood pressure reading was found, and CQL counts it as not controlled. ${SEE_NEXT}`,
  cms2: `A depression screening was found, and CQL does not count it yet. ${SEE_NEXT}`,
  cms137: `Treatment was found, and CQL does not count it as initiation. ${SEE_NEXT}`,
};
const ENGAGEMENT_REASON = `The gap is about continuing treatment (engagement), which an order does not close. ${SEE_NEXT}`;
const UNREADABLE_REASON = "This run did not record what CQL found, so WorkWell offers no order.";

const hasEvaluationError = (evidence: unknown): boolean =>
  typeof evidence === "object" && evidence !== null && "evaluationError" in (evidence as Record<string, unknown>);

export function orderApplicability(measureId: string, outcome: ApplicabilityInput): Applicability {
  const orders = ordersForMeasure(measureId);
  if (!orders) return { applies: false, reason: "No order is defined for this measure." };
  if (!AT_RISK_STATUSES.has(outcome.status)) return { applies: false, reason: "This gap is not open." };
  if (outcome.outOfPopulation === true && outcome.status === "MISSING_DATA") {
    return { applies: false, reason: "The measure does not apply to this patient." };
  }
  if (hasEvaluationError(outcome.evidence)) {
    return { applies: false, reason: "The evaluation failed, so WorkWell offers no order." };
  }
  if (orders.offerOn === "at-risk") return { applies: true };

  const findings = cqlFindingsOf(measureId, {
    status: outcome.status,
    evidence: (outcome.evidence ?? null) as never,
    outOfPopulation: outcome.outOfPopulation,
  });
  if (!findings) return { applies: false, reason: UNREADABLE_REASON };
  const firstRate = officialMeasureSemantics(measureId)?.rateLabels?.[0] ?? null;
  const onLaterRate = findings.rate !== null && firstRate !== null && findings.rate !== firstRate;
  if (orders.offerOn === "none-found-first-rate" && onLaterRate) return { applies: false, reason: ENGAGEMENT_REASON };
  switch (findings.status) {
    case "NONE_FOUND":
      return { applies: true };
    case "NUMERATOR_EVIDENCE":
    case "LATEST_NOT_QUALIFYING":
      return { applies: false, reason: FOUND_REASON[measureId] ?? `Something was found, and CQL does not count it. ${SEE_NEXT}` };
    case "NOT_EXPOSED_BY_LOGIC":
      return { applies: false, reason: onLaterRate ? ENGAGEMENT_REASON : UNREADABLE_REASON };
    default:
      return { applies: false, reason: UNREADABLE_REASON };
  }
}
