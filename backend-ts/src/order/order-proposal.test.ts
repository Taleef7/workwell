// backend-ts/src/order/order-proposal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeOrders, type AtRiskOutcome } from "./order-proposal.ts";
import type { StandingOrderProvider } from "./standing-order-provider.ts";

const noStanding: StandingOrderProvider = { checksExistingOrders: true, activeOrdersFor: () => [] };

// Evidence fixtures in the shape a run persists (#875): population flags plus CQL's recorded facts.
const pop = (numer: boolean) => ({ ipp: true, denom: true, numer, denex: false, denexcep: false });
const facts = (values: Array<[string, string]>) => ({ spec: 1, values: values.map(([define, value]) => ({ define, value })) });
/** CMS122 where CQL found no glycemic assessment: the one case an HbA1c order closes. */
const cms122NoRecord = { official: { ecqmId: "122FHIR", version: "1.0.000", populationResults: pop(true) }, cqlFacts: facts([["Has No Record Of Glycemic Status Assessment", "true"]]) };

test("Panel=Risk: only OVERDUE/DUE_SOON/MISSING_DATA propose; COMPLIANT/EXCLUDED do not", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "audiogram", status: "OVERDUE" },
    { subjectId: "e2", measureId: "audiogram", status: "DUE_SOON" },
    { subjectId: "e3", measureId: "audiogram", status: "MISSING_DATA" },
    { subjectId: "e4", measureId: "audiogram", status: "COMPLIANT" },
    { subjectId: "e5", measureId: "audiogram", status: "EXCLUDED" },
  ];
  const { proposed } = proposeOrders(rows, noStanding);
  assert.deepEqual(proposed.map((p) => p.subjectId).sort(), ["e1", "e2", "e3"]);
});

test("risk tier → priority (OVERDUE urgent; DUE_SOON/MISSING_DATA routine)", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "audiogram", status: "OVERDUE" },
    { subjectId: "e2", measureId: "audiogram", status: "DUE_SOON" },
    { subjectId: "e3", measureId: "audiogram", status: "MISSING_DATA" },
  ];
  const { proposed } = proposeOrders(rows, noStanding);
  const byId = Object.fromEntries(proposed.map((p) => [p.subjectId, p.priority]));
  assert.equal(byId.e1, "urgent");
  assert.equal(byId.e2, "routine");
  assert.equal(byId.e3, "routine");
});

test("in-batch dedupe: same subject+order proposed once", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "diabetes_hba1c", status: "OVERDUE" }, // 83036
    { subjectId: "e1", measureId: "cms122", status: "OVERDUE", evidence: cms122NoRecord }, // also 83036 → same dedupeKey
  ];
  const { proposed, suppressed } = proposeOrders(rows, noStanding);
  // Both measures share CPT 83036 → ONE proposal (first-seen measure wins). The second is dropped,
  // NOT moved to suppressed[] (suppressed[] is only for standing-order matches). This is the
  // intended same-code collapse — see the comment in order-proposal.ts.
  assert.equal(proposed.filter((p) => p.subjectId === "e1").length, 1);
  assert.equal(proposed[0]!.measureId, "diabetes_hba1c"); // first-seen wins
  assert.equal(suppressed.length, 0);
});

test("in-batch dedupe priority upgrade: routine first then urgent → emits urgent", () => {
  // diabetes_hba1c DUE_SOON (routine) then cms122 OVERDUE (urgent) → same CPT 83036 key
  // The second row must UPGRADE the proposal to urgent, not be dropped silently.
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "diabetes_hba1c", status: "DUE_SOON" },
    { subjectId: "e1", measureId: "cms122", status: "OVERDUE", evidence: cms122NoRecord },
  ];
  const { proposed, suppressed } = proposeOrders(rows, noStanding);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]!.priority, "urgent", "priority upgraded to urgent by the OVERDUE row");
  assert.equal(proposed[0]!.reasonOutcome, "OVERDUE", "reasonOutcome reflects the upgrading outcome");
  assert.equal(suppressed.length, 0);
});

test("in-batch dedupe priority upgrade: urgent first then routine → stays urgent (no downgrade)", () => {
  // Reverse order: OVERDUE seen first (urgent), DUE_SOON second (routine) — must NOT downgrade.
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "cms122", status: "OVERDUE", evidence: cms122NoRecord },
    { subjectId: "e1", measureId: "diabetes_hba1c", status: "DUE_SOON" },
  ];
  const { proposed, suppressed } = proposeOrders(rows, noStanding);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]!.priority, "urgent", "urgent proposal is not downgraded by subsequent routine row");
  assert.equal(suppressed.length, 0);
});

test("standing-order suppression moves a proposal to suppressed[]", () => {
  const standing: StandingOrderProvider = {
    checksExistingOrders: true,
    activeOrdersFor: (id) => (id === "e1" ? [{ subjectId: "e1", order: { code: "92557", system: "http://www.ama-assn.org/go/cpt", display: "x" } }] : []),
  };
  const rows: AtRiskOutcome[] = [{ subjectId: "e1", measureId: "audiogram", status: "OVERDUE" }];
  const { proposed, suppressed } = proposeOrders(rows, standing);
  assert.equal(proposed.length, 0);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0]!.suppressedByStandingOrder, true);
  assert.equal(suppressed[0]!.priority, "urgent"); // priority still derived from the OVERDUE risk tier
});

test("measure with no catalog entry yields no proposal", () => {
  const rows: AtRiskOutcome[] = [{ subjectId: "e1", measureId: "respirator_fit_test", status: "OVERDUE" }];
  assert.equal(proposeOrders(rows, noStanding).proposed.length, 0);
});

// --- #620 / #640: protocol vs choice, offered only when CQL found nothing -----------------------------

const cms165Uncontrolled = {
  official: { ecqmId: "165FHIR", version: "1.0.000", populationResults: pop(false) },
  cqlFacts: facts([["Most Recent Blood Pressure Day", "2026-03-22"], ["Lowest Systolic Reading on Most Recent Blood Pressure Day", "152 'mm[Hg]'"]]),
};
const cms165NoReading = { official: { ecqmId: "165FHIR", version: "1.0.000", populationResults: pop(false) }, cqlFacts: facts([]) };

test("cms122 with a reading over 9% gets NO order: a new HbA1c does not fix a result already found", () => {
  const overNine = {
    official: { ecqmId: "122FHIR", version: "1.0.000", populationResults: pop(true) },
    cqlFacts: facts([["Most Recent Glycemic Status Date", "2026-02-10"], ["Has No Record Of Glycemic Status Assessment", "false"]]),
  };
  const r = proposeOrders([{ subjectId: "e1", measureId: "cms122", status: "OVERDUE", evidence: overNine }], noStanding);
  assert.equal(r.proposed.length, 0);
  assert.equal(r.choices.length, 0);
});

test("cms122 with no evidence recorded gets no order: unreadable never becomes 'order it'", () => {
  const r = proposeOrders([{ subjectId: "e1", measureId: "cms122", status: "OVERDUE" }], noStanding);
  assert.equal(r.proposed.length, 0);
});

test("a choice measure yields a choice row with every option and NO order (no default)", () => {
  const r = proposeOrders([{ subjectId: "e1", measureId: "cms130", status: "OVERDUE" }], noStanding);
  assert.equal(r.proposed.length, 0, "a choice never enters the protocol list or the bundle");
  assert.equal(r.choices.length, 1);
  const c = r.choices[0]!;
  assert.equal("order" in c, false, "a choice row carries no order");
  assert.equal(c.priority, "urgent");
  assert.equal(c.optionKeys.length, 5);
});

test("cms165: an uncontrolled reading gets nothing; no reading at all gets the choice", () => {
  assert.equal(proposeOrders([{ subjectId: "e1", measureId: "cms165", status: "OVERDUE", evidence: cms165Uncontrolled }], noStanding).choices.length, 0);
  assert.equal(proposeOrders([{ subjectId: "e1", measureId: "cms165", status: "OVERDUE", evidence: cms165NoReading }], noStanding).choices.length, 1);
});

test("per-option standing order: an active order for any option withholds the whole choice", () => {
  const standing: StandingOrderProvider = {
    checksExistingOrders: true,
    activeOrdersFor: () => [{ subjectId: "e1", order: { code: "82274", system: "http://www.ama-assn.org/go/cpt", display: "FIT" } }],
  };
  const r = proposeOrders([{ subjectId: "e1", measureId: "cms130", status: "OVERDUE" }], standing);
  assert.equal(r.choices.length, 0);
  assert.equal(r.suppressedChoices.length, 1);
});

test("an out-of-population MISSING_DATA row gets no choice", () => {
  const r = proposeOrders([{ subjectId: "e1", measureId: "cms130", status: "MISSING_DATA", outOfPopulation: true }], noStanding);
  assert.equal(r.choices.length, 0);
});

test("per-option dedupe: the same choice twice for one subject is offered once", () => {
  const r = proposeOrders(
    [
      { subjectId: "e1", measureId: "cms130", status: "OVERDUE" },
      { subjectId: "e1", measureId: "cms130", status: "DUE_SOON" },
      { subjectId: "e2", measureId: "cms130", status: "DUE_SOON" },
    ],
    noStanding,
  );
  assert.deepEqual(r.choices.map((c) => c.subjectId), ["e1", "e2"], "each subject once; another subject is not deduped");
});
