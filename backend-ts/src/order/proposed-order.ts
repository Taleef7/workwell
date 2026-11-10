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

/**
 * A choice measure's open gap (#640 item 3): the options the clinician picks from, and NO order. Nothing
 * downstream may treat one option as the default, so there is no `order` field to fall back on.
 */
export interface ChoiceProposal {
  subjectId: string;
  measureId: string;
  reasonOutcome: string;
  priority: OrderPriority;
  /** `system|code` of each option still open after dedupe, in catalog order. */
  optionKeys: string[];
  authoredOn: string;
}

export function dedupeKeyFor(subjectId: string, order: OrderCode): string {
  return `${subjectId}:${order.system}|${order.code}`;
}

/**
 * `clinicCode`: the clinic's own code for this order (#640 item 2), from an APPROVED terminology mapping,
 * added as a second coding so the receiving system recognises it. Never a `urn:workwell:*` code
 * (`order/approved-codes.ts`).
 */
export function toServiceRequest(p: ProposedOrder, clinicCode?: OrderCode | null): unknown {
  const coding = [{ system: p.order.system, code: p.order.code, display: p.order.display }];
  if (clinicCode) coding.push({ system: clinicCode.system, code: clinicCode.code, display: clinicCode.display });
  return {
    resourceType: "ServiceRequest",
    intent: "proposal",
    status: "draft",
    priority: p.priority,
    subject: { reference: `Patient/${p.subjectId}` },
    code: { coding, text: p.order.display },
    reasonCode: [{ text: `${p.measureId} — ${p.reasonOutcome}` }],
    authoredOn: p.authoredOn,
  };
}

export function bundleOf(proposals: ProposedOrder[], clinicCodes?: ReadonlyMap<string, OrderCode>): unknown {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: proposals.map((p) => ({ resource: toServiceRequest(p, clinicCodes?.get(`${p.order.system}|${p.order.code}`)) })),
  };
}
