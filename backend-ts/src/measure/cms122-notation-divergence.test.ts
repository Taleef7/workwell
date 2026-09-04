import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { MEASURE_IDENTITY } from "./measure-identity.ts";

/*
 * cms122's improvement notation DELIBERATELY diverges between the two tables
 * (issue #521), and each value is correct for its own consumer:
 *
 * - `MEASURE_BINDINGS.cms122` says "increase" because the AUTHORED subset's
 *   numerator IS the compliant bucket (the authored CQL inverts the official
 *   measure's poor-control numerator), so higher rate = better control.
 * - `MEASURE_IDENTITY.cms122` says "decrease" because it describes the OFFICIAL
 *   CMS artifact: its numerator is poor glycemic control (HbA1c > 9% or not
 *   assessed), so being in it is the failure. The Programs UI reads only the
 *   identity table, so this is the value it must show.
 *
 * #377 retires the authored cms122/cms125 binding rows; after that the binding
 * row has nothing left to describe, so the divergence disappears with it rather
 * than being reconciled in place.
 *
 * This test fails if EITHER table changes silently — neither may "fix" the
 * divergence by agreeing with the other, because each is keyed to a different
 * numerator semantics.
 */
test("cms122: binding says increase (authored) while identity says decrease (official) — deliberate divergence", () => {
  assert.equal(MEASURE_BINDINGS.cms122?.improvementNotation, "increase");
  assert.equal(MEASURE_IDENTITY.cms122?.improvementNotation, "decrease");
});

test("cms125: binding and identity AGREE on increase — cms122 is the only deliberate divergence", () => {
  assert.equal(MEASURE_BINDINGS.cms125?.improvementNotation, "increase");
  assert.equal(MEASURE_IDENTITY.cms125?.improvementNotation, "increase");
});
