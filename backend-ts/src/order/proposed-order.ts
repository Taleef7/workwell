/**
 * Order proposal types + FHIR mapping (#77 E7). A ProposedOrder is advisory — a human reviews and
 * submits; nothing is auto-ordered. toServiceRequest emits FHIR R4 ServiceRequest (intent=proposal,
 * status=draft) so the output is EH-ready; hand-built JSON (no FHIR runtime dep), like MeasureReport/QRDA.
 */
export type OrderPriority = "urgent" | "routine";

export interface OrderCode {
  code: string;
  system: string;
  display: string;
}

export interface ProposedOrder {
  subjectId: string;
  measureId: string;
  order: OrderCode;
  reasonOutcome: string; // OVERDUE | DUE_SOON | MISSING_DATA
  priority: OrderPriority;
  status: "PROPOSED";
  dedupeKey: string;
  authoredOn: string; // YYYY-MM-DD
  /** Present (true) only on the suppressed-list view (suppressed by an existing standing order). */
  suppressedByStandingOrder?: boolean;
}

export function dedupeKeyFor(subjectId: string, order: OrderCode): string {
  return `${subjectId}:${order.system}|${order.code}`;
}

export function toServiceRequest(p: ProposedOrder): unknown {
  return {
    resourceType: "ServiceRequest",
    intent: "proposal",
    status: "draft",
    priority: p.priority,
    subject: { reference: `Patient/${p.subjectId}` },
    code: { coding: [{ system: p.order.system, code: p.order.code, display: p.order.display }] },
    reasonCode: [{ text: `${p.measureId} — ${p.reasonOutcome}` }],
    authoredOn: p.authoredOn,
  };
}

export function bundleOf(proposals: ProposedOrder[]): unknown {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: proposals.map((p) => ({ resource: toServiceRequest(p) })),
  };
}
