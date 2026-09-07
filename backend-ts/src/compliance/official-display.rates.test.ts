/**
 * A multi-rate measure's OVERDUE wording names the rate the patient actually missed (MM-1 U3, ADR-074).
 *
 * The bucket is the worst of Initiation and Engagement, so "OVERDUE" alone covers two clinically
 * different situations: a new episode nobody started treating, and a patient who started treatment and
 * then did not come back. The persisted `evidence_json.official.rates` says which. Wording that read the
 * bucket alone had to describe both halves in one sentence and told the staff "the evidence shows which
 * rate was missed" — while the case page rendered rate 1's populations and the raw JSON. Every consumer
 * of the display table (roster cell, case detail, next action, and through them the CDS card) reads the
 * rates when they are present, so the rate that failed is what the staff member sees.
 *
 * CQL decided the outcome; this is prose about a persisted result, never a rule (AI_GUARDRAILS §1).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { officialDisplayFor, missedRateIndex, multiRateExclusionActive, OVERDUE_BY_RATE } from "./official-display.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { deriveCell } from "./roster-vocabulary.ts";
import { deriveWhyFlagged } from "../case/case-detail-read-model.ts";
import { nextActionFor } from "../case/case-logic.ts";

type Population = { populationType: string; result: boolean };
const rate = (opts: { ipp: boolean; denom: boolean; numer: boolean; denex?: boolean; denexcep?: boolean }): Population[] => [
  { populationType: "initial-population", result: opts.ipp },
  { populationType: "denominator", result: opts.denom },
  { populationType: "denominator-exclusion", result: opts.denex ?? false },
  { populationType: "denominator-exception", result: opts.denexcep ?? false },
  { populationType: "numerator", result: opts.numer },
];
const IN = { ipp: true, denom: true };
const evidenceWithRates = (r1: Population[], r2: Population[]) => ({
  expressionResults: [],
  official: { ecqmId: "CMS137", populationResults: r1, rates: [r1, r2], measurementPeriod: { start: "2026-01-01", end: "2026-12-31" } },
});

/** Never initiated: rate 1 missed. */
const NOT_INITIATED = evidenceWithRates(rate({ ...IN, numer: false }), rate({ ...IN, numer: false }));
/** Initiated, then never engaged: rate 1 met, rate 2 missed — the 8-of-45 shape in the steward's deck. */
const NOT_ENGAGED = evidenceWithRates(rate({ ...IN, numer: true }), rate({ ...IN, numer: false }));
/** Rate 1 excluded, rate 2 in denominator and missed — exclusion on one rate must not read as "missed". */
const EXCLUDED_THEN_NOT_ENGAGED = evidenceWithRates(rate({ ...IN, numer: false, denex: true }), rate({ ...IN, numer: false }));

let previousRouting: string | undefined;
beforeEach(() => {
  previousRouting = process.env.WORKWELL_OFFICIAL_MEASURES;
  process.env.WORKWELL_OFFICIAL_MEASURES = "cms122,cms125,cms137";
});
afterEach(() => {
  if (previousRouting === undefined) delete process.env.WORKWELL_OFFICIAL_MEASURES;
  else process.env.WORKWELL_OFFICIAL_MEASURES = previousRouting;
});

test("cms137 OVERDUE with no initiation names the 14-day initiation gap and not engagement", () => {
  const d = officialDisplayFor("cms137", "OVERDUE", NOT_INITIATED)!;
  assert.match(d.method, /without treatment initiation within 14 days/i);
  assert.doesNotMatch(d.method, /engaged/i);
  assert.match(d.whyFlagged, /no treatment (was )?initiated within 14 days/i);
  assert.match(d.nextAction, /initiat/i);
  assert.doesNotMatch(d.nextAction, /engagement/i);
});

test("cms137 OVERDUE after initiation names the 34-day engagement gap and says treatment WAS initiated", () => {
  const d = officialDisplayFor("cms137", "OVERDUE", NOT_ENGAGED)!;
  assert.match(d.method, /initiated but not engaged within 34 days/i);
  assert.doesNotMatch(d.method, /without treatment initiation/i);
  assert.match(d.whyFlagged, /treatment was initiated/i);
  assert.match(d.whyFlagged, /not engaged/i);
  assert.match(d.nextAction, /engagement|follow-up/i);
  assert.doesNotMatch(d.nextAction, /confirm initiation/i);
});

test("a rate the patient is excluded from is not the missed rate", () => {
  const d = officialDisplayFor("cms137", "OVERDUE", EXCLUDED_THEN_NOT_ENGAGED)!;
  assert.match(d.method, /initiated but not engaged within 34 days/i);
  // The combined fallback ALSO matches the line above ("…or treatment initiated but not engaged…"), so
  // without this the test passes when no rate is selected at all (review finding).
  assert.doesNotMatch(d.method, /without treatment initiation/i);
  assert.deepEqual(d, officialDisplayFor("cms137", "OVERDUE", NOT_ENGAGED));
});

test("every per-rate wording table has exactly one entry per reviewed rate label, in the same order", () => {
  // OVERDUE_BY_RATE is indexed by artifact group order and rateLabels names that order; a table one
  // entry short would silently fall back to the combined wording for the last rate.
  for (const [measureId, byRate] of Object.entries(OVERDUE_BY_RATE)) {
    assert.deepEqual(byRate.length, officialMeasureSemantics(measureId)?.rateLabels?.length, measureId);
  }
  assert.ok(Object.keys(OVERDUE_BY_RATE).includes("cms137"));
});

test("without persisted rates the combined wording stands, byte-for-byte", () => {
  const combined = officialDisplayFor("cms137", "OVERDUE")!;
  assert.deepEqual(officialDisplayFor("cms137", "OVERDUE", { expressionResults: [] }), combined);
  assert.deepEqual(officialDisplayFor("cms137", "OVERDUE", { official: { populationResults: rate({ ...IN, numer: false }) } }), combined);
  assert.match(combined.method, /initiation within 14 days/i);
  assert.match(combined.method, /engaged within 34 days/i);
});

test("a single-rate measure ignores evidence, and non-OVERDUE statuses are unchanged", () => {
  assert.deepEqual(officialDisplayFor("cms122", "OVERDUE", NOT_ENGAGED), officialDisplayFor("cms122", "OVERDUE"));
  assert.deepEqual(officialDisplayFor("cms137", "COMPLIANT", NOT_ENGAGED), officialDisplayFor("cms137", "COMPLIANT"));
  assert.deepEqual(officialDisplayFor("cms137", "MISSING_DATA", NOT_ENGAGED), officialDisplayFor("cms137", "MISSING_DATA"));
});

test("the missed rate follows the measure's numerator semantics — on an inverse measure the numerator IS the miss", () => {
  // cms137 is higher-is-better, so nothing about it changes. But `outcomeFromPopulations` reads
  // `numeratorMeansCompliant`, and a rate reader that hard-codes "missed = not in numerator" would, on
  // the day an inverse multi-rate measure is onboarded, name the rate the patient PASSED as the gap.
  const r1 = rate({ ...IN, numer: true });
  const r2 = rate({ ...IN, numer: false });
  assert.equal(missedRateIndex(evidenceWithRates(r1, r2), true), 1);
  assert.equal(missedRateIndex(evidenceWithRates(r1, r2), false), 0);
  assert.equal(missedRateIndex(evidenceWithRates(r2, r2), false), -1);
  assert.equal(missedRateIndex({ official: { populationResults: r2 } }, true), -1, "no rates, no index");
});

test("the roster cell, the case detail and the next action all read the missed rate", () => {
  const cell = deriveCell("OVERDUE", NOT_ENGAGED, "cms137", "2026-01-01");
  assert.equal(cell.status, "OVERDUE");
  assert.match(cell.method, /initiated but not engaged/i);

  const wf = deriveWhyFlagged(NOT_ENGAGED, "cms137", "2026-01-01", "OVERDUE") as { official_summary?: string };
  assert.match(wf.official_summary ?? "", /treatment was initiated/i);

  assert.match(nextActionFor("OVERDUE", "cms137", NOT_ENGAGED), /engagement|follow-up/i);
  assert.doesNotMatch(nextActionFor("OVERDUE", "cms137", NOT_ENGAGED), /confirm initiation/i);
  assert.match(nextActionFor("OVERDUE", "cms137", NOT_INITIATED), /initiat/i);
  // The two-argument form every existing caller uses still returns the combined wording.
  assert.equal(nextActionFor("OVERDUE", "cms137"), officialDisplayFor("cms137", "OVERDUE")!.nextAction);
});

/**
 * `waiver_status` answers from the rate the CASE is about (issue #537, ADR-074 d13).
 *
 * `deriveWhyFlagged` read it off the first `expressionResults` define whose name matched
 * /waiver|exemption|exclusion|contraindication/, which on a multi-rate outcome is always rate 1's —
 * the labels are `official:<Rate>:<population>` in rate order. Exact for CMS137, whose two rates share
 * one denominator and one exclusion expression, and wrong for the first multi-rate measure vendored
 * with per-rate exclusions: a case about the rate the subject missed would report the other rate's
 * exclusion. Reading from `official.rates` also removes a second place for a reviewed label to drift.
 */
test("multiRateExclusionActive answers from the MISSED rate, not from rate 1", () => {
  const pop = (over: Record<string, boolean>) => [
    { populationType: "initial-population", result: true },
    { populationType: "denominator", result: true },
    { populationType: "denominator-exclusion", result: over.excluded ?? false },
    { populationType: "numerator", result: over.numerator ?? false },
  ];
  // Rate 1 is excluded (so not the missed one); rate 2 is in the denominator and missed, not excluded.
  const rate1Excluded = { official: { rates: [pop({ excluded: true }), pop({ numerator: false })] } };
  assert.equal(multiRateExclusionActive(rate1Excluded, true), false, "the missed rate carries no exclusion");

  // The mirror: rate 1 is missed and IS excluded... which cannot happen, because an excluded rate is
  // not a miss. So with rate 1 excluded and rate 2 met, no rate is missed and the fallback applies:
  // an exclusion anywhere is what put the subject in the bucket.
  const noneMissed = { official: { rates: [pop({ excluded: true }), pop({ numerator: true })] } };
  assert.equal(multiRateExclusionActive(noneMissed, true), true, "no missed rate ⇒ an exclusion anywhere answers");

  // Neither excluded, rate 2 missed.
  const plainMiss = { official: { rates: [pop({ numerator: true }), pop({ numerator: false })] } };
  assert.equal(multiRateExclusionActive(plainMiss, true), false);
});

test("multiRateExclusionActive returns null for anything that is not multi-rate", () => {
  // null is the caller's signal to keep the single-rate derivation — NOT a "no exclusion" answer, which
  // would silently blank `waiver_status` for every authored and single-rate official measure.
  assert.equal(multiRateExclusionActive(undefined, true), null);
  assert.equal(multiRateExclusionActive({}, true), null);
  assert.equal(multiRateExclusionActive({ official: { rates: [[]] } }, true), null, "one rate is not multi-rate");
});
