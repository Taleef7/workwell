/**
 * The cross-engine comparison reads EVERY group of both MeasureReports (MM-1 U3, ADR-074).
 *
 * `scripts/cross-engine-check.ts` compared `group[0]` of the steward's expected report against
 * `group[0]` of the second engine's. For CMS137 that is Initiation alone: an Engagement disagreement —
 * the rate the measure exists to surface — read as agreement. The comparison is the shared classifier
 * over every rate, and a divergence names the rate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareReports, allZeroAcrossRates, engineErrorOf } from "./cross-engine.ts";

const population = (code: string, count: number) => ({ code: { coding: [{ code }] }, count });
const group = (ipp: number, denom: number, numer: number) => ({
  population: [population("initial-population", ipp), population("denominator", denom), population("numerator", numer)],
});
const report = (...groups: ReturnType<typeof group>[]) => ({ resourceType: "MeasureReport", group: groups });

test("a two-group measure agrees only when every group agrees, and a divergence names the rate", () => {
  const expected = report(group(1, 1, 1), group(1, 1, 0));
  const agree = compareReports(expected, report(group(1, 1, 1), group(1, 1, 0)));
  assert.equal(agree.agreement.pass, true);
  assert.equal(agree.expected.length, 2);
  assert.equal(agree.actual.length, 2);

  const engagementOnly = compareReports(expected, report(group(1, 1, 1), group(1, 1, 1)));
  assert.equal(engagementOnly.agreement.pass, false);
  assert.deepEqual(engagementOnly.agreement.rateDifferences, ["rate 2 numerator: expected 0, got 1"]);
});

test("a second engine that returns one group for a two-group measure is a mismatch, not a pass on rate 1", () => {
  const result = compareReports(report(group(1, 1, 1), group(1, 1, 0)), report(group(1, 1, 1)));
  assert.equal(result.agreement.pass, false);
});

test("single-group reports compare exactly as before — one rate, the flat classifier", () => {
  const result = compareReports(report(group(1, 1, 0)), report(group(1, 1, 0)));
  assert.equal(result.agreement.pass, true);
  assert.equal(result.expected.length, 1);
  const off = compareReports(report(group(1, 1, 0)), report(group(1, 1, 1)));
  assert.deepEqual(off.agreement.differences, ["numerator"]);
});

test("a report with no group at all is a zero vector, not an infinite recursion (review finding)", () => {
  // `populationCountsByRate` on a group-less report used to fall back to `populationCounts`, which is
  // defined as rate 1 of `populationCountsByRate` — a loop. An expected report is read OUTSIDE the
  // sweep's try, so a group-less one would have taken the whole sweep down where the old reader
  // returned zeros.
  const result = compareReports({ resourceType: "MeasureReport" }, report(group(0, 0, 0)));
  assert.equal(result.expected.length, 1);
  assert.deepEqual(Object.values(result.expected[0]!), [0, 0, 0, 0, 0]);
  assert.equal(result.agreement.pass, true);
});

test("#846: a numerator 1 against the steward's 0 is a disagreement on every case, CMS122's former six included", () => {
  const result = compareReports(report(group(1, 1, 0)), report(group(1, 1, 1)));
  assert.equal(result.agreement.status, "mismatch");
  assert.equal(result.agreement.pass, false);
  assert.deepEqual(result.agreement.differences, ["numerator"]);
});

test("#846: an engine exception inside a MeasureReport is an engine error, not a set of counts", () => {
  // cqf-fhir-cr's shape for CMS165's 45e01fed: every population 0, the exception in a contained
  // OperationOutcome (cqframework/clinical-reasoning#1071).
  const thrown = {
    ...report(group(0, 0, 0)),
    contained: [
      {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "exception", diagnostics: "Unable to extract codes from fhirType Reference" }],
      },
    ],
  };
  assert.equal(engineErrorOf(thrown), "Unable to extract codes from fhirType Reference");
  const withDetails = { contained: [{ resourceType: "OperationOutcome", issue: [{ severity: "fatal", details: { text: "boom" } }] }] };
  assert.equal(engineErrorOf(withDetails), "boom");
  const textless = { contained: [{ resourceType: "OperationOutcome", issue: [{ severity: "error" }] }] };
  assert.equal(engineErrorOf(textless), "an OperationOutcome error with no text");
  // A warning beside real counts is still a result, and so is a report with no contained resources.
  const warned = { ...report(group(1, 1, 1)), contained: [{ resourceType: "OperationOutcome", issue: [{ severity: "warning", diagnostics: "slow" }] }] };
  assert.equal(engineErrorOf(warned), undefined);
  assert.equal(engineErrorOf(report(group(1, 1, 1))), undefined);
  assert.equal(engineErrorOf(null), undefined);
  // Other contained resources are not errors.
  assert.equal(engineErrorOf({ contained: [{ resourceType: "Patient", issue: [{ severity: "error" }] }] }), undefined);
});

test("the all-zero refusal looks at every rate — a zero Initiation beside a populated Engagement is not degenerate", () => {
  assert.equal(allZeroAcrossRates([group(0, 0, 0), group(0, 0, 0)].map((g) => compareReports(report(g), report(g)).actual[0]!)), true);
  const populated = compareReports(report(group(0, 0, 0), group(1, 1, 0)), report(group(0, 0, 0), group(1, 1, 0)));
  assert.equal(allZeroAcrossRates(populated.actual), false);
});
