/**
 * #397 — the runtime CQL translator has a UCUM service, so unit-bearing CQL compiles.
 *
 * The defect this pins was live in production and invisible to the entire suite, because **no committed
 * measure uses a unit**. `pnpm compile-measures` was green, every measure test was green, and the Studio's
 * ELM Explorer still could not compile `5 'mg'`. It surfaced only when the V7 conformance harness ran CQL
 * somebody else wrote, where it accounted for 155 of 183 apparent translation errors (ADR-060).
 *
 * So the test that matters is not "the validator returns null for 'mg'" — that would have passed before
 * the fix too, since the validator already existed under `scripts/`. It is **"the translator compiles a
 * library containing a quantity"**, asserted against the same entry point production calls.
 *
 * `NO_UCUM_SERVICE` exists so the before-state stays reachable: a fix nobody can watch fail is a fix
 * nobody can verify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCql, NO_UCUM_SERVICE } from "./cql-translator.ts";
import { convertUnit, validateUnit } from "./ucum.ts";

/** Minimal, self-contained: no FHIR model, no retrieves — only the quantity literal is under test. */
const WITH_QUANTITY = `library UnitBearing version '1.0.0'

define "A Dose": 5 'mg'
define "A Length": 1.0 'cm'
define "Bigger": 5 'mg' > 2 'mg'
`;

const WITHOUT_QUANTITY = `library Plain version '1.0.0'

define "Two": 1 + 1
`;

test("#397: a library with quantity literals compiles through the default path", () => {
  const result = compileCql(WITH_QUANTITY);
  assert.equal(result.ok, true, `expected ok, got diagnostics: ${JSON.stringify(result.diagnostics)}`);
  assert.deepEqual(
    result.diagnostics.filter((d) => d.severity.toLowerCase() === "error"),
    [],
  );
  assert.ok(result.elm, "no ELM produced");
});

test("#397: the same library FAILS without a UCUM service — the fix is doing something", () => {
  // Mutation check, kept as a test rather than run by hand: if this ever starts passing, the default
  // service has stopped being load-bearing and the test above no longer proves anything.
  const result = compileCql(WITH_QUANTITY, { validateUnit: NO_UCUM_SERVICE });
  assert.equal(result.ok, false, "expected failure without a UCUM service");
  assert.match(
    result.diagnostics.map((d) => d.message).join("\n"),
    /UCUM/i,
    "the failure should name the missing UCUM service",
  );
});

test("CQL with no units is unaffected either way", () => {
  // Guards the claim that this change is inert for every committed measure: none uses a unit, so the
  // two paths must agree exactly on unit-free CQL.
  const withService = compileCql(WITHOUT_QUANTITY);
  const withoutService = compileCql(WITHOUT_QUANTITY, { validateUnit: NO_UCUM_SERVICE });
  assert.equal(withService.ok, true);
  assert.equal(withoutService.ok, true);
  assert.deepEqual(withService.elm, withoutService.elm, "a UCUM service must not change unit-free output");
});

test("an invalid unit is REJECTED, not waved through", () => {
  // The failure mode a permissive stub would create: malformed CQL passing the authoring gate and
  // surfacing later as a wrong number. `'grams'` is not a UCUM symbol — `g` is.
  const result = compileCql(`library BadUnit version '1.0.0'\n\ndefine "Bad": 5 'grams'\n`);
  assert.equal(result.ok, false, "an unrecognized UCUM atom must not compile");
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /grams/, "the message should name the offending unit");
});

test("a custom validator overrides the default", () => {
  // The harness relies on this to measure the translator's own behaviour.
  const refuseEverything = compileCql(WITH_QUANTITY, { validateUnit: () => "nope" });
  assert.equal(refuseEverything.ok, false);
});

test("the validator itself: valid symbols, prefixes, annotations and refusals", () => {
  for (const u of ["mg", "cm", "mL", "kg", "d", "wk", "mo", "a", "[lb_av]", "{tablet}", "mg/dL", "10*3", "1"]) {
    assert.equal(validateUnit(u), null, `${u} should be valid`);
  }
  for (const u of ["grams", "furlong", "", "zz"]) {
    assert.notEqual(validateUnit(u), null, `${u} must be rejected`);
  }
});

test("conversion refuses rather than guessing a factor", () => {
  // A silent wrong factor corrupts results invisibly. Translation never asks — cql-execution converts at
  // runtime — so refusing costs nothing and removes a whole class of silent error.
  assert.equal(convertUnit(5, "mg", "mg"), 5, "an identity conversion is not a guess");
  assert.throws(() => convertUnit(5, "mg", "g"), /does not implement UCUM conversion/);
});
