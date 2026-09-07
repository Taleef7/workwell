/**
 * A multi-rate measure's persisted `expressionResults` carry EVERY rate, labelled (MM-1 U3, ADR-074).
 *
 * `populationExpressionResults` is what the Evidence Explorer, the auditor packet and the AI explain
 * prompt read. For cms137 it carried rate 1's populations only, so an initiated-but-not-engaged patient's
 * case showed `official:numerator = true` under an OVERDUE heading — a true statement about Initiation
 * presented as the whole story. The labels are the semantics table's own, reviewed with the measure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { populationExpressionResults } from "./official-executor-adapter.ts";
import { officialMeasureSemantics } from "./official-measure-semantics.ts";

const rate = (numer: boolean) => [
  { populationType: "initial-population", result: true },
  { populationType: "denominator", result: true },
  { populationType: "numerator", result: numer },
];

test("cms137's semantics name its two rates in artifact order; single-rate measures name none", () => {
  assert.deepEqual(officialMeasureSemantics("cms137")?.rateLabels, ["Initiation", "Engagement"]);
  assert.equal(officialMeasureSemantics("cms122")?.rateLabels, undefined);
  assert.equal(officialMeasureSemantics("cms2")?.rateLabels, undefined);
});

test("a single-rate measure's expressionResults are unchanged — one `official:<population>` per population", () => {
  assert.deepEqual(populationExpressionResults(rate(true)), [
    { define: "official:initial-population", result: true },
    { define: "official:denominator", result: true },
    { define: "official:numerator", result: true },
  ]);
  // The rates argument with ONE rate is the single-rate shape, not a labelled one.
  assert.deepEqual(populationExpressionResults(rate(true), [rate(true)], ["Initiation"]), populationExpressionResults(rate(true)));
});

test("a multi-rate measure's expressionResults carry every rate under its label", () => {
  const results = populationExpressionResults(rate(true), [rate(true), rate(false)], ["Initiation", "Engagement"]);
  assert.deepEqual(results, [
    { define: "official:Initiation:initial-population", result: true },
    { define: "official:Initiation:denominator", result: true },
    { define: "official:Initiation:numerator", result: true },
    { define: "official:Engagement:initial-population", result: true },
    { define: "official:Engagement:denominator", result: true },
    { define: "official:Engagement:numerator", result: false },
  ]);
});

test("a rate without a reviewed label is named by its position rather than dropped", () => {
  const results = populationExpressionResults(rate(true), [rate(true), rate(false), rate(false)], ["Initiation", "Engagement"]);
  assert.ok(results.some((r) => r.define === "official:rate 3:numerator" && r.result === false));
  assert.equal(results.length, 9);
});
