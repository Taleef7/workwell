/**
 * When an order could close a gap (#620, #640): only when the measure's own CQL found nothing.
 *   node --import tsx --test src/order/order-applicability.test.ts
 *
 * Each refusal here is a card or a case page that would otherwise say "order X" where ordering does not
 * close the gap (AI_GUARDRAILS §1.1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderApplicability } from "./order-applicability.ts";

const pop = (numer: boolean) => ({ ipp: true, denom: true, numer, denex: false, denexcep: false });
const facts = (values: Array<[string, string]>) => ({ spec: 1, values: values.map(([define, value]) => ({ define, value })) });
const official = (ecqmId: string, numer: boolean, cqlFacts: unknown, extra: Record<string, unknown> = {}) => ({
  official: { ecqmId, version: "1.0.000", populationResults: pop(numer), ...extra },
  cqlFacts,
});

test("cms122: no record applies; a result over 9% does not; a run that recorded nothing does not", () => {
  assert.deepEqual(
    orderApplicability("cms122", { status: "OVERDUE", evidence: official("122FHIR", true, facts([["Has No Record Of Glycemic Status Assessment", "true"]])) }),
    { applies: true },
  );
  const over = orderApplicability("cms122", {
    status: "OVERDUE",
    evidence: official("122FHIR", true, facts([["Most Recent Glycemic Status Date", "2026-02-10"], ["Has No Record Of Glycemic Status Assessment", "false"]])),
  });
  assert.equal(over.applies, false);
  assert.equal(orderApplicability("cms122", { status: "OVERDUE", evidence: official("122FHIR", true, undefined) }).applies, false);
});

test("cms2: no screening applies; a screening found (positive, no follow-up) does not", () => {
  assert.equal(orderApplicability("cms2", { status: "OVERDUE", evidence: official("2FHIR", false, facts([])) }).applies, true);
  const found = orderApplicability("cms2", {
    status: "OVERDUE",
    evidence: official("2FHIR", false, facts([["Most Recent Adult Depression Screening", "Observation 2026-03-01 positive"]])),
  });
  assert.equal(found.applies, false);
  assert.match((found as { reason: string }).reason, /does not count it yet/);
});

test("cms137: only the Initiation rate with nothing found; Engagement is never an order", () => {
  const rate = (numer: boolean) => [
    { populationType: "initial-population", result: true },
    { populationType: "denominator", result: true },
    { populationType: "numerator", result: numer },
  ];
  const initiation = orderApplicability("cms137", {
    status: "OVERDUE",
    evidence: { official: { ecqmId: "137FHIR", version: "1.0.000", populationResults: rate(false), rates: [rate(false), rate(false)] }, cqlFacts: facts([]) },
  });
  assert.deepEqual(initiation, { applies: true });
  const engagement = orderApplicability("cms137", {
    status: "OVERDUE",
    evidence: {
      official: { ecqmId: "137FHIR", version: "1.0.000", populationResults: rate(true), rates: [rate(true), rate(false)] },
      cqlFacts: facts([["Treatment Initiation With Medication Order Dates", "[2026-04-02]"]]),
    },
  });
  assert.equal(engagement.applies, false);
  assert.match((engagement as { reason: string }).reason, /engagement/);
});

test("cms125 and cms130 apply on any open gap; a closed gap, an out-of-population row and an error never do", () => {
  assert.deepEqual(orderApplicability("cms130", { status: "OVERDUE" }), { applies: true });
  assert.deepEqual(orderApplicability("cms125", { status: "DUE_SOON" }), { applies: true });
  assert.equal(orderApplicability("cms130", { status: "COMPLIANT" }).applies, false);
  assert.equal(orderApplicability("cms130", { status: "MISSING_DATA", outOfPopulation: true }).applies, false);
  assert.equal(orderApplicability("cms130", { status: "OVERDUE", evidence: { evaluationError: "engine failure" } }).applies, false);
  assert.equal(orderApplicability("respirator_fit_test", { status: "OVERDUE" }).applies, false, "no catalog entry, no order");
});
