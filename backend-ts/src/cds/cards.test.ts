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
import { readdirSync, readFileSync } from "node:fs";
import { buildComplianceCards, cardUuid, noEvaluationCard, suggestionUuid, type CardInput } from "./cards.ts";
import { ORDER_CATALOG } from "../order/order-catalog.ts";
import { dispositionFor } from "../case/case-logic.ts";
import { proposeOrders } from "../order/order-proposal.ts";
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
  patientId: "emp-006",
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

test("`critical` is never emitted: OVERDUE is the ceiling, and it is `warning`", async () => {
  // In CDS Hooks `critical` means the user must not proceed. WorkWell is SUPPLEMENTARY to WebChart
  // (locked decision 1) and is not entitled to say that about someone else's encounter.
  //
  // **The type is the enforcement, not this test.** `CdsCard.indicator` is `"info" | "warning"`, so an
  // assertion that the value is one of those two cannot fail for any implementation — a first version of
  // this test did exactly that and read as coverage while being unfailable (review). What IS failable, and
  // what actually pins the ceiling, is the `priorityFor` mapping below: flip either branch and this fails.
  const byStatus: Array<[string, string]> = [
    ["OVERDUE", "warning"],
    ["DUE_SOON", "info"],
    ["MISSING_DATA", "info"],
  ];
  for (const [status, expected] of byStatus) {
    const cards = await buildComplianceCards([row("audiogram", status)], opts());
    assert.equal(cards.length, 1, `${status} must produce a card`);
    assert.equal(cards[0]!.indicator, expected, `${status} must map to ${expected}`);
  }
  // And read through a widened type, so this keeps working — and keeps failing — if `CdsCard` ever admits
  // `critical`. Without the widening the compiler makes the comparison unreachable.
  const emitted = (await buildComplianceCards([row("audiogram", "OVERDUE")], opts()))[0]!;
  assert.notEqual((emitted.indicator as string), "critical");
});

test("a FAILED evaluation is reported as ours, not as a missing record in the chart", async () => {
  // PARTIAL_FAILURE is terminal, so its rows are served, and a subject whose evaluation threw is persisted
  // MISSING_DATA + evidence.evaluationError (DATA_MODEL_CONTRACTS §5). Without a branch for it, `deriveCell`
  // falls through to "No record on file" and `nextActionFor` says "Collect the missing documentation" —
  // asserting a fact about the PATIENT when our engine threw (review).
  const failed = row("audiogram", "MISSING_DATA", {
    evidence: { evaluationError: "CQL engine failure", message: "boom" },
  });
  const cards = await buildComplianceCards([failed], opts());
  assert.equal(cards.length, 1);
  const card = cards[0]!;
  assert.match(card.summary, /could not be evaluated/);
  assert.equal(card.indicator, "info", "our failure is never a warning about the patient");
  assert.match(card.detail!, /no compliance gap is being asserted either way/);
  assert.doesNotMatch(card.detail!, /Collect the missing/);
  assert.doesNotMatch(card.summary, /missing data/i);
  // And it must never carry an order derived from a status the engine did not compute.
  assert.equal(card.suggestions, undefined);
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

test("a suggested order references the id the CLIENT sent, not WorkWell's internal subject id", async () => {
  // On a live tenant these differ: WorkWell persists `wc|4821`, the hook supplies `4821`. A ServiceRequest
  // referencing `Patient/wc|4821` names nothing the client can resolve, and `|` is not a legal FHIR id — so
  // the suggestion could not be applied (Codex review).
  const cards = await buildComplianceCards([row("audiogram", "OVERDUE")], {
    ...opts(),
    subjectId: "wc|4821",
    patientId: "4821",
  });
  const resource = cards[0]!.suggestions![0]!.actions[0]!.resource as { subject: { reference: string } };
  assert.equal(resource.subject.reference, "Patient/4821");
  assert.doesNotMatch(resource.subject.reference, /\|/, "a FHIR id may not contain a pipe");
  // The internal id still keys card identity, so feedback correlation is unaffected.
  assert.equal(cards[0]!.uuid, await cardUuid(RUN, "wc|4821", "audiogram"));
});

test("card and suggestion uuids are deterministic, UUID-shaped, and distinct per measure", async () => {
  // Determinism is what lets the feedback endpoint exist with no schema change: the id is recomputable
  // from (runId, subjectId, measureId) rather than stored.
  const a = await cardUuid(RUN, "emp-006", "audiogram");
  const again = await cardUuid(RUN, "emp-006", "audiogram");
  assert.equal(a, again, "the same card must always get the same uuid");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // A CONFORMANT uuid, not merely a hash in uuid shape: CDS Hooks types `card.uuid` as a UUID, so a client
  // validating the version nibble or storing it in a native `uuid` column would reject a bare hash (review).
  // Version 8 = RFC 9562 "custom", which is what a deterministic application-defined id is; variant 10xx.
  assert.equal(a[14], "8", "version nibble must be 8");
  assert.ok("89ab".includes(a[19]!), `variant nibble must be 8/9/a/b, got ${a[19]}`);
  assert.notEqual(a, await cardUuid(RUN, "emp-006", "cms125"), "different measure → different uuid");
  assert.notEqual(a, await cardUuid(RUN, "emp-007", "audiogram"), "different subject → different uuid");
  assert.notEqual(a, await cardUuid("other-run", "emp-006", "audiogram"), "different run → different uuid");
  // A card uuid and its suggestion uuid must not collide — feedback distinguishes them.
  assert.notEqual(a, await suggestionUuid(RUN, "emp-006", "audiogram"));

  const cards = await buildComplianceCards([row("audiogram", "OVERDUE")], opts());
  assert.equal(cards[0]!.uuid, a, "the emitted card must carry the derived uuid");
  assert.equal(cards[0]!.suggestions![0]!.uuid, await suggestionUuid(RUN, "emp-006", "audiogram"));
});

test("the carded statuses and the order-proposal statuses are the SAME set — the coupling the dedupe rests on", () => {
  // Cards are selected by `dispositionFor(status) === "OPEN"`; proposals by `AT_RISK` in order-proposal.ts.
  // Today those sets are identical, which is why the first card to claim a collapsed proposal is always the
  // row that created it. If they diverge — someone adds a status to one and not the other — the claiming
  // card and the ServiceRequest's `reasonCode` would name DIFFERENT measures, and the genuinely at-risk
  // measure would silently lose its suggestion to a non-at-risk one (review flagged this as load-bearing and
  // unpinned). This test is the pin; it has no other purpose.
  const ALL = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED", "DECLINED", "IN_PROGRESS"];
  const carded = ALL.filter((s) => dispositionFor(s) === "OPEN").sort();
  // Mirrors AT_RISK's keys. Kept as a literal so a change to either side shows up as a diff here.
  const atRisk = ["OVERDUE", "DUE_SOON", "MISSING_DATA"].sort();
  assert.deepEqual(carded, atRisk);
  // And prove the consequence rather than just the sets: an at-risk status yields a proposal for a mapped
  // measure, so a carded row can always claim one.
  for (const status of carded) {
    const { proposed } = proposeOrders([{ subjectId: "emp-006", measureId: "audiogram", status }], NO_STANDING_ORDERS);
    assert.equal(proposed.length, 1, `${status} is carded, so it must also propose`);
  }
});

test("the CDS sources contain no invisible control characters", () => {
  // Twice in one session a `sed -i` over this UTF-8 source replaced a space with a literal NUL byte, which
  // reached a commit: it typechecked, every test passed, and the only symptom was `grep` reporting the file
  // as binary. An invisible byte in a string literal that feeds a hash is exactly the kind of thing that is
  // correct-by-accident until it is not. Cheap to assert, and it would have caught both occurrences.
  const dir = new URL(".", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(new URL(name, dir), "utf8");
    // Tab, LF and CR are legitimate; nothing else below 0x20 is, and neither is a NUL.
    const bad = [...text].filter((ch) => ch < " " && ch !== "\n" && ch !== "\r" && ch !== "\t");
    assert.deepEqual(bad, [], `${name} contains ${bad.length} control character(s)`);
  }
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
