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
import { compareReports, allZeroAcrossRates } from "./cross-engine.ts";
import { CMS122_KNOWN_BAD_EXPECTEDS } from "./official-cases.ts";

const population = (code: string, count: number) => ({ code: { coding: [{ code }] }, count });
const group = (ipp: number, denom: number, numer: number) => ({
  population: [population("initial-population", ipp), population("denominator", denom), population("numerator", numer)],
});
const report = (...groups: ReturnType<typeof group>[]) => ({ resourceType: "MeasureReport", group: groups });

test("a two-group measure agrees only when every group agrees, and a divergence names the rate", () => {
  const expected = report(group(1, 1, 1), group(1, 1, 0));
  const agree = compareReports("cms137", "case-a", expected, report(group(1, 1, 1), group(1, 1, 0)));
  assert.equal(agree.agreement.pass, true);
  assert.equal(agree.expected.length, 2);
  assert.equal(agree.actual.length, 2);

  const engagementOnly = compareReports("cms137", "case-b", expected, report(group(1, 1, 1), group(1, 1, 1)));
  assert.equal(engagementOnly.agreement.pass, false);
  assert.deepEqual(engagementOnly.agreement.rateDifferences, ["rate 2 numerator: expected 0, got 1"]);
});

test("a second engine that returns one group for a two-group measure is a mismatch, not a pass on rate 1", () => {
  const result = compareReports("cms137", "case-c", report(group(1, 1, 1), group(1, 1, 0)), report(group(1, 1, 1)));
  assert.equal(result.agreement.pass, false);
});

test("single-group reports compare exactly as before — one rate, the flat classifier", () => {
  const result = compareReports("cms125", "case-d", report(group(1, 1, 0)), report(group(1, 1, 0)));
  assert.equal(result.agreement.pass, true);
  assert.equal(result.expected.length, 1);
  const off = compareReports("cms125", "case-e", report(group(1, 1, 0)), report(group(1, 1, 1)));
  assert.deepEqual(off.agreement.differences, ["numerator"]);
});

test("a report with no group at all is a zero vector, not an infinite recursion (review finding)", () => {
  // `populationCountsByRate` on a group-less report used to fall back to `populationCounts`, which is
  // defined as rate 1 of `populationCountsByRate` — a loop. An expected report is read OUTSIDE the
  // sweep's try, so a group-less one would have taken the whole sweep down where the old reader
  // returned zeros.
  const result = compareReports("cms125", "no-group", { resourceType: "MeasureReport" }, report(group(0, 0, 0)));
  assert.equal(result.expected.length, 1);
  assert.deepEqual(Object.values(result.expected[0]!), [0, 0, 0, 0, 0]);
  assert.equal(result.agreement.pass, true);
});

test("the CMS122 reference-agreement exemption survives the extraction — the same uuid, the same narrow shape", () => {
  // The steward's own expected numerator is wrong for six CMS122 cases; the engine matching the
  // REFERENCE (numerator 1, expected 0) is a pass on exactly those uuids and nothing else.
  const uuid = [...CMS122_KNOWN_BAD_EXPECTEDS][0]!;
  const ref = compareReports("cms122", uuid, report(group(1, 1, 0)), report(group(1, 1, 1)));
  assert.equal(ref.agreement.status, "reference-agreement");
  assert.equal(ref.agreement.pass, true);
  const other = compareReports("cms122", "some-other-case", report(group(1, 1, 0)), report(group(1, 1, 1)));
  assert.equal(other.agreement.status, "mismatch");
});

test("the all-zero refusal looks at every rate — a zero Initiation beside a populated Engagement is not degenerate", () => {
  assert.equal(allZeroAcrossRates([group(0, 0, 0), group(0, 0, 0)].map((g) => compareReports("cms137", "z", report(g), report(g)).actual[0]!)), true);
  const populated = compareReports("cms137", "p", report(group(0, 0, 0), group(1, 1, 0)), report(group(0, 0, 0), group(1, 1, 0)));
  assert.equal(allZeroAcrossRates(populated.actual), false);
});
