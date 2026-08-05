/**
 * The C2 acceptance test: `@workwell/measure-engine` evaluates a measure it has never heard of, supplied
 * entirely by a consumer that shares no code with the app.
 *
 *   node --import tsx --test packages/example-consumer/src/index.test.ts
 *
 * This is the test that would fail if the engine re-acquired a dependency on WorkWell's catalog — and it
 * would fail by *not evaluating*, which is a stronger signal than an import-graph assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, evaluate, ELM_LIBRARIES, MEASURES, buildBundle } from "./index.ts";

const EVAL = "2026-06-12";

test("an outside consumer's measure evaluates to each of its own outcomes", async () => {
  // COMPLIANT — an adult with a completed booster.
  const compliant = await evaluate({ id: "p1", birthDate: "1980-01-01", lastBoosterOn: "2024-03-01" }, EVAL);
  assert.equal(compliant.outcome, "COMPLIANT");
  assert.equal(compliant.measure, "Tetanus Booster Currency", "the consumer's own measure name comes back");
  assert.equal(compliant.subjectId, "p1");

  // OVERDUE — an adult with no booster at all.
  assert.equal((await evaluate({ id: "p2", birthDate: "1980-01-01" }, EVAL)).outcome, "OVERDUE");

  // MISSING_DATA — a minor is outside this measure's initial population.
  const minor = await evaluate({ id: "p3", birthDate: "2015-01-01" }, EVAL);
  assert.equal(minor.outcome, "MISSING_DATA");
  assert.equal(minor.inInitialPopulation, false, "the engine surfaces IPP membership for a consumer too");
});

test("the evidence carries the consumer's OWN define names", async () => {
  // Proof that nothing is being mapped through a WorkWell vocabulary on the way out.
  const out = await evaluate({ id: "p1", birthDate: "1980-01-01", lastBoosterOn: "2024-03-01" }, EVAL);
  const defines = out.evidence.expressionResults.map((e) => e.define);
  for (const d of ["Initial Population", "Has Recent Booster", "Outcome Status"]) {
    assert.ok(defines.includes(d), `missing define ${d} — got ${defines.join(", ")}`);
  }
});

test("the content really is the consumer's", () => {
  // Deliberately small: it asserts what this package SUPPLIES. The property that the engine holds no
  // catalog of its own is the next test, which is the one that can actually fail if that changes.
  // (A first cut ended with `.constructor.name === "Promise"` — an assertion about JavaScript, not about
  // this codebase, and unfailable. Removed rather than left as the shape this repo keeps catching.)
  assert.deepEqual(Object.keys(MEASURES), ["tetanus_booster"]);
  assert.ok(ELM_LIBRARIES["FHIRHelpers-4.0.1"], "FHIRHelpers is the consumer's to supply — the engine loads it eagerly");
  assert.ok(ELM_LIBRARIES["TetanusBooster-1.0.0"]);
});

test("a WorkWell measure id is unknown here — the engine has no catalog of its own", async () => {
  await assert.rejects(
    () => createEngine().evaluate({ measureId: "audiogram", patientBundle: buildBundle({ id: "x", birthDate: "1980-01-01" }), evaluationDate: EVAL }),
    /unknown measure 'audiogram'/,
    "if this ever resolves, the engine has re-acquired WorkWell's catalog",
  );
});

test("omitting FHIRHelpers fails loudly at construction, not silently at evaluation", () => {
  // The API fact this package exists to have discovered: the constructor loads FHIRHelpers eagerly.
  assert.throws(
    () => new (createEngine().constructor as new (o: unknown) => unknown)({
      measures: MEASURES,
      elmLibraries: { "TetanusBooster-1.0.0": ELM_LIBRARIES["TetanusBooster-1.0.0"] },
    }),
    /FHIRHelpers/,
  );
});
