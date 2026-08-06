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

test("grouped denominators and a leading solidus are valid UCUM (review, #402)", () => {
  // `mg/(kg.d)` is an ordinary dose rate. Splitting on `.` and `/` with a plain regex turned it into
  // `["mg", "(kg", "d)"]` and rejected it — a false rejection that blocks an author for no reason.
  // `/min` and `/uL` were rejected for a different reason: an empty first component, which is the `1`
  // UCUM implies before a leading solidus.
  for (const u of ["mg/(kg.d)", "/min", "/uL", "(mg)", "g/(2.d)", "umol/(L.s)"]) {
    assert.equal(validateUnit(u), null, `${u} should be valid`);
  }
  // Unbalanced grouping is still refused, so the fix did not simply stop looking.
  for (const u of ["mg/(kg.d", "mg)", "mg/()", "mg{a{b}}"]) {
    assert.notEqual(validateUnit(u), null, `${u} must be rejected`);
  }
});

test("repeated solidus is legal — the UCUM grammar is left-recursive (review, #402)", () => {
  // A review comment held that an ungrouped expression permits only one division operator. It does not:
  // `<term> ::= <term> "." <component> | <term> "/" <component> | <component>`, so `mg/kg/d` parses as
  // `(mg/kg)/d`. Pinned because "fixing" this would introduce a false rejection.
  for (const u of ["mg/kg/d", "mol/L/s"]) {
    assert.equal(validateUnit(u), null, `${u} is valid UCUM and must not be rejected`);
  }
});

test("a prefix attaches only to a METRIC atom (review, #402)", () => {
  // The false ACCEPTANCE — the direction this module claims not to fail in, so the more serious shape.
  // `[lb_av]` is a real atom and `m` a real prefix, but an avoirdupois pound is not metric, so there is
  // no such thing as a millipound. Time units above the second are the same case: `s` is metric,
  // `min`/`h`/`d` are not, so `mmin` is not "millisecond-ish", it is nothing.
  for (const u of ["m[lb_av]", "mmin", "m[degF]", "k[in_i]", "dmo"]) {
    assert.notEqual(validateUnit(u), null, `${u} must be rejected — the atom is not metric`);
  }
  // The metric cases still work, including the one that looks like the counter-example: `mm[Hg]` is
  // milli + the metric atom `m[Hg]`, whereas bare `mmHg` is not a UCUM symbol at all.
  for (const u of ["mm[Hg]", "ms", "kg", "dL", "ueq", "mCel"]) {
    assert.equal(validateUnit(u), null, `${u} should be valid`);
  }
  assert.notEqual(validateUnit("mmHg"), null, "`mmHg` is not a UCUM symbol — `mm[Hg]` is");
});

test("whitespace anywhere inside a unit is rejected (review, #402)", () => {
  // Per-component `trim()` accepted `mg / dL`. UCUM codes contain no whitespace; trimming the OUTSIDE is
  // our own hygiene, whitespace INSIDE is the author's error.
  for (const u of ["mg / dL", "mg dL", "m g"]) {
    assert.notEqual(validateUnit(u), null, `${JSON.stringify(u)} must be rejected`);
  }
  assert.equal(validateUnit("  mg  "), null, "outer whitespace is still tolerated");
});

test("conversion refuses rather than guessing a factor", () => {
  // A silent wrong factor corrupts results invisibly. Translation never asks — cql-execution converts at
  // runtime — so refusing costs nothing and removes a whole class of silent error.
  assert.equal(convertUnit(5, "mg", "mg"), 5, "an identity conversion is not a guess");
  assert.throws(() => convertUnit(5, "mg", "g"), /does not implement UCUM conversion/);
});
