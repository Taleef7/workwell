/**
 * CDS Hooks card assembly (ADR-067).
 *   node --import tsx --test src/cds/cards.test.ts
 *
 * The load-bearing tests here are the three REFUSALS, because each one is a place where a plausible
 * implementation would have been wrong in a way no client could detect: `critical` is never emitted, a
 * suggestion is never offered for an unapproved order code, and an absence of data never renders as
 * silence. Everything else is shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComplianceCards, cardUuid, noEvaluationCard, suggestionUuid, type CardInput } from "./cards.ts";
import { ORDER_CATALOG } from "../order/order-catalog.ts";
import type { StandingOrderProvider } from "../order/standing-order-provider.ts";

/** No standing orders, so suppression never confounds a suggestion assertion. */
const NO_STANDING_ORDERS: StandingOrderProvider = { activeOrdersFor: () => [] };

const CPT = "http://www.ama-assn.org/go/cpt";
/** The three APPROVED mappings in `value-set-seed.ts`, as the route would compute them from the store. */
const APPROVED = new Set([`${CPT}|92557`, `${CPT}|86580`, "http://hl7.org/fhir/sid/cvx|141"]);

const RUN = "11111111-2222-3333-4444-555555555555";

function row(measureId: string, status: string, extra: Partial<CardInput> = {}): CardInput {
  return {
    measureId,
    status,
    evidence: {
      expressionResults: [
        { define: "Most Recent Audiogram Date", result: "2025-03-10T00:00:00Z" },
        { define: "Days Since Last Audiogram", result: 420 },
      ],
    },
    evaluationPeriod: "2026-06-12",
    runId: RUN,
    evaluatedAt: "2026-06-12T03:00:11.482Z",
    ...extra,
  };
}

const opts = (approved: ReadonlySet<string> = APPROVED) => ({
  subjectId: "emp-006",
  approvedOrderCodes: approved,
  standingOrders: NO_STANDING_ORDERS,
  studioBaseUrl: "https://studio.example.org",
  authoredOn: "2026-06-12",
});

test("an open gap becomes one card carrying the answer, its provenance and a link", async () => {
  const cards = await buildComplianceCards([row("audiogram", "OVERDUE")], opts());
  assert.equal(cards.length, 1);
  const card = cards[0]!;
  assert.match(card.summary, /Annual Audiogram Completed/);
  assert.match(card.summary, /overdue/);
  assert.equal(card.source.label, "WorkWell Measure Studio");
  // The card must say the answer came from CQL and name the run — an unattributed clinical claim in a
  // chart is the thing docs/AI_GUARDRAILS.md exists to prevent.
  assert.match(card.detail!, /Computed by CQL/);
  assert.match(card.detail!, new RegExp(RUN));
  assert.deepEqual(card.links, [
    { label: "Open in WorkWell", url: "https://studio.example.org/compliance?subjectId=emp-006", type: "absolute" },
  ]);
});

test("`critical` is never emitted, for any open status", async () => {
  // In CDS Hooks `critical` means the user must not proceed. WorkWell is SUPPLEMENTARY to WebChart
  // (locked decision 1) and is not entitled to say that about someone else's encounter. `CdsCard` makes
  // it a type error; this asserts the runtime consequence over every status that produces a card.
  for (const status of ["OVERDUE", "DUE_SOON", "MISSING_DATA"]) {
    const cards = await buildComplianceCards([row("audiogram", status)], opts());
    assert.equal(cards.length, 1, `${status} must produce a card`);
    assert.ok(
      cards[0]!.indicator === "info" || cards[0]!.indicator === "warning",
      `${status} produced indicator ${cards[0]!.indicator}`,
    );
  }
  // OVERDUE is the most urgent thing we say, and it is `warning` — the ceiling.
  const overdue = await buildComplianceCards([row("audiogram", "OVERDUE")], opts());
  assert.equal(overdue[0]!.indicator, "warning");
  const dueSoon = await buildComplianceCards([row("audiogram", "DUE_SOON")], opts());
  assert.equal(dueSoon[0]!.indicator, "info");
});

test("a suggestion is offered ONLY for an APPROVED order code", async () => {
  const withApproval = await buildComplianceCards([row("audiogram", "OVERDUE")], opts());
  const s = withApproval[0]!.suggestions;
  assert.equal(s?.length, 1);
  assert.equal(withApproval[0]!.selectionBehavior, "at-most-one");
  const action = s![0]!.actions[0]!;
  assert.equal(action.type, "create");
  const resource = action.resource as { resourceType: string; intent: string; status: string };
  assert.equal(resource.resourceType, "ServiceRequest");
  // Advisory by construction — a human submits. Never an active order.
  assert.equal(resource.intent, "proposal");
  assert.equal(resource.status, "draft");

  // The same row with nothing approved carries no suggestion — and no dangling selectionBehavior, which
  // the spec only permits alongside suggestions.
  const withoutApproval = await buildComplianceCards([row("audiogram", "OVERDUE")], opts(new Set()));
  assert.equal(withoutApproval[0]!.suggestions, undefined);
  assert.equal(withoutApproval[0]!.selectionBehavior, undefined);
});

test("cms122 and cms125 get NO suggestion under the real approved set — the documented consequence", async () => {
  // Their CPT codes are in ORDER_CATALOG but have no terminology mapping at all, so `order-catalog.ts`'s
  // own "representative (demo, not billing-certified)" caveat applies and they must not be offered for
  // one-click creation in a certified EHR. If a mapping is later APPROVED this test SHOULD fail — it is
  // pinning the rule's consequence, so the rule changing is exactly when someone should look.
  assert.equal(ORDER_CATALOG["cms125"]?.code, "77067", "guard: the catalog still maps cms125");
  assert.equal(ORDER_CATALOG["cms122"]?.code, "83036", "guard: the catalog still maps cms122");
  for (const measureId of ["cms122", "cms125"]) {
    const cards = await buildComplianceCards([row(measureId, "OVERDUE")], opts());
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.suggestions, undefined, `${measureId} must carry no suggestion`);
    assert.ok(cards[0]!.links!.length > 0, `${measureId} must still carry a link`);
  }
});

test("two measures sharing one order code collapse to ONE suggestion", async () => {
  // diabetes_hba1c and cms122 both map to CPT 83036. One order is the correct clinical action, so
  // `proposeOrders` collapses them; the measure that did not win still gets an information card.
  const approved = new Set([`${CPT}|83036`]);
  const cards = await buildComplianceCards(
    [row("diabetes_hba1c", "OVERDUE"), row("cms122", "OVERDUE")],
    opts(approved),
  );
  assert.equal(cards.length, 2);
  const withSuggestions = cards.filter((c) => c.suggestions);
  assert.equal(withSuggestions.length, 1, "exactly one card may offer the shared order");
});

test("compliant, excluded and deprecated measures produce no cards", async () => {
  for (const status of ["COMPLIANT", "EXCLUDED"]) {
    assert.deepEqual(await buildComplianceCards([row("audiogram", status)], opts()), [], status);
  }
  // A Deprecated catalog measure is not something to raise mid-encounter.
  assert.deepEqual(await buildComplianceCards([row("lead_medical_surveillance", "OVERDUE")], opts()), []);
});

test("summary respects the spec's 140-character cap even for a long measure name", async () => {
  // cms177v14's catalog name is ~90 chars; the longest are longer still. The cap is a conformance
  // requirement, so it is enforced rather than hoped for.
  const cards = await buildComplianceCards([row("cms135v14", "OVERDUE")], opts());
  assert.equal(cards.length, 1);
  assert.ok(cards[0]!.summary.length <= 140, `summary was ${cards[0]!.summary.length} chars`);
  assert.match(cards[0]!.summary, /…$/, "a truncated summary must show that it was truncated");
});

test("no studio base URL means no links, never a broken one", async () => {
  const cards = await buildComplianceCards([row("audiogram", "OVERDUE")], {
    ...opts(),
    studioBaseUrl: undefined,
  });
  assert.equal(cards[0]!.links, undefined);
  assert.equal(cards[0]!.source.url, undefined);
});

test("card and suggestion uuids are deterministic, UUID-shaped, and distinct per measure", async () => {
  // Determinism is what lets the feedback endpoint exist with no schema change: the id is recomputable
  // from (runId, subjectId, measureId) rather than stored.
  const a = await cardUuid(RUN, "emp-006", "audiogram");
  const again = await cardUuid(RUN, "emp-006", "audiogram");
  assert.equal(a, again, "the same card must always get the same uuid");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(a, await cardUuid(RUN, "emp-006", "cms125"), "different measure → different uuid");
  assert.notEqual(a, await cardUuid(RUN, "emp-007", "audiogram"), "different subject → different uuid");
  assert.notEqual(a, await cardUuid("other-run", "emp-006", "audiogram"), "different run → different uuid");
  // A card uuid and its suggestion uuid must not collide — feedback distinguishes them.
  assert.notEqual(a, await suggestionUuid(RUN, "emp-006", "audiogram"));

  const cards = await buildComplianceCards([row("audiogram", "OVERDUE")], opts());
  assert.equal(cards[0]!.uuid, a, "the emitted card must carry the derived uuid");
  assert.equal(cards[0]!.suggestions![0]!.uuid, await suggestionUuid(RUN, "emp-006", "audiogram"));
});

test("an absence of data is a CARD, and it does not claim compliance", async () => {
  const card = noEvaluationCard("wc|4821");
  assert.equal(card.indicator, "info");
  assert.match(card.summary, /No WorkWell evaluation on record/);
  assert.match(card.summary, /wc\|4821/, "the id must be echoed so a namespace mismatch is visible");
  // The whole point: it must not be readable as "this patient is fine".
  assert.match(card.detail!, /absence of a run/);
  assert.doesNotMatch(card.detail!, /\bcompliant\b(?!\.)/i);
  assert.equal(card.suggestions, undefined);
});
