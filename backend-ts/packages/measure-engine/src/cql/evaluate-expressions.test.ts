/**
 * `evaluateExpressions` — the package's data-free execution surface (ADR-060).
 *
 *   node --import tsx --test packages/measure-engine/src/cql/evaluate-expressions.test.ts
 *
 * Fixtures are hand-written ELM rather than translated here: the translator lives app-side, and a package
 * test must not reach into the app (`package-boundary.test.ts` refuses exactly that). The V7 harness
 * covers the translator→engine round trip over 1,835 real cases; this covers the contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpressions } from "./evaluate-expressions.ts";

/** Minimal ELM for `define <name>: <literal>` over System types. */
function literalLibrary(defs: Array<{ name: string; value: string; type: string }>): unknown {
  return {
    library: {
      identifier: { id: "Fixture", version: "1.0.0" },
      schemaIdentifier: { id: "urn:hl7-org:elm", version: "r1" },
      usings: { def: [{ localIdentifier: "System", uri: "urn:hl7-org:elm-types:r1" }] },
      statements: {
        def: defs.map((d) => ({
          name: d.name,
          context: "Unfiltered",
          accessLevel: "Public",
          expression: { type: "Literal", valueType: `{urn:hl7-org:elm-types:r1}${d.type}`, value: d.value },
        })),
      },
    },
  };
}

test("returns every define's value with no patient context", async () => {
  const defines = await evaluateExpressions(
    literalLibrary([
      { name: "Answer", value: "42", type: "Integer" },
      { name: "Greeting", value: "hello", type: "String" },
    ]),
  );
  assert.equal(defines["Answer"], 42);
  assert.equal(defines["Greeting"], "hello");
});

test("a library with no defines yields an empty object, not a throw", async () => {
  // The corpus contains only expression cases, but an empty result must be distinguishable from a
  // failure — a harness that cannot tell those apart reports a broken run as a clean one.
  assert.deepEqual(await evaluateExpressions(literalLibrary([])), {});
});

test("names are returned verbatim, so a caller can key on the define it asked for", async () => {
  const defines = await evaluateExpressions(literalLibrary([{ name: "Passed", value: "true", type: "Boolean" }]));
  assert.equal(Object.hasOwn(defines, "Passed"), true);
  assert.equal(defines["Passed"], true);
});

test("malformed ELM throws rather than returning empty", async () => {
  // The distinction this preserves: `{}` means "no defines", never "something went wrong". Swallowing
  // the error would make an engine defect indistinguishable from an empty library.
  await assert.rejects(() => evaluateExpressions({ not: "elm" }));
});
