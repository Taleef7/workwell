/**
 * CQL result → FHIR `Parameters` serialization (#474, the `$cql` facade).
 *   node --import tsx --test src/fhir/cql-result-parameters.test.ts
 *
 * The wire contract here is not ours to invent: it is what `cqframework/cql-tests-runner`'s extractor
 * chain reads back (its `src/extractors/`, read 2026-08-24), which is itself the CQL IG's Evaluation
 * Service mapping (FHIR-56226 for numeric intervals). The load-bearing conventions, each pinned below:
 *
 *   - the result parameter is named `return`; a LIST is repeated `return` parameters, one per element;
 *   - `null` is `_valueBoolean` carrying `data-absent-reason: unknown` (there is no value[x] for null);
 *   - an EMPTY list/tuple is `_valueBoolean` carrying `cqf-isEmptyList` / `cqf-isEmptyTuple` — absence
 *     of parameters would read as "no result at all" (`undefined`), a different thing;
 *   - a numeric interval is `valueRange` with UNITY-coded quantities (`code: '1'`) plus a `cqf-cqlType`
 *     extension naming `Interval<System.X>` — without the extension the runner reads it as a Quantity
 *     interval and the comparison changes semantics;
 *   - open numeric boundaries are emitted CLOSED-NORMALIZED, because the extractor derives closedness
 *     from boundary PRESENCE (a present low is `lowClosed: true` regardless of what we meant).
 *
 * Values are produced by the REAL pipeline (compileCql → evaluateExpressions) rather than hand-built
 * cql-execution objects, so the serializer is tested against what the engine actually returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpressions } from "@work-well/measure-engine";
import { compileCql } from "../measure/cql-translator.ts";
import { resultToParameters, evaluationErrorParameters, declaredResultType } from "./cql-result-parameters.ts";

async function evalExpr(expression: string): Promise<unknown> {
  const compiled = compileCql(`library T version '1.0.0'\ndefine Result: ${expression}\n`);
  assert.ok(compiled.ok, `expression should compile: ${expression}`);
  const results = await evaluateExpressions((compiled as { elm: unknown }).elm);
  return (results as Record<string, unknown>).Result;
}

async function serialize(expression: string) {
  return resultToParameters(await evalExpr(expression));
}

/** What the $cql route does (#482): value + the compiled define's declared result type. */
async function serializeTyped(expression: string) {
  const compiled = compileCql(`library T version '1.0.0'\ndefine Result: ${expression}\n`);
  assert.ok(compiled.ok, `expression should compile: ${expression}`);
  const def = (compiled.elm as { library?: { statements?: { def?: { name?: string }[] } } }).library?.statements?.def?.find(
    (d) => d.name === "Result",
  );
  const results = await evaluateExpressions(compiled.elm);
  return resultToParameters((results as Record<string, unknown>).Result, declaredResultType(def));
}

function params(p: { parameter?: unknown[] }): Record<string, unknown>[] {
  return (p.parameter ?? []) as Record<string, unknown>[];
}

function firstParam(p: { parameter?: unknown[] }): Record<string, unknown> {
  const first = params(p)[0];
  assert.ok(first, "expected at least one parameter");
  return first;
}

test("an integer result is one `return` parameter with valueInteger", async () => {
  const out = await serialize("1 + 2");
  assert.equal(out.resourceType, "Parameters");
  assert.deepEqual(params(out), [{ name: "return", valueInteger: 3 }]);
});

test("a boolean result uses valueBoolean", async () => {
  assert.deepEqual(params(await serialize("true")), [{ name: "return", valueBoolean: true }]);
});

test("a decimal result uses valueDecimal", async () => {
  assert.deepEqual(params(await serialize("1.5")), [{ name: "return", valueDecimal: 1.5 }]);
});

test("a string result uses valueString", async () => {
  assert.deepEqual(params(await serialize("'abc'")), [{ name: "return", valueString: "abc" }]);
});

test("null is data-absent-reason unknown on _valueBoolean — the runner's null encoding", async () => {
  assert.deepEqual(params(await serialize("null")), [
    {
      name: "return",
      _valueBoolean: {
        extension: [
          { url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" },
        ],
      },
    },
  ]);
});

test("an empty list is cqf-isEmptyList, not an absent parameter", async () => {
  assert.deepEqual(params(await serialize("{}")), [
    {
      name: "return",
      _valueBoolean: {
        extension: [
          { url: "http://hl7.org/fhir/StructureDefinition/cqf-isEmptyList", valueBoolean: true },
        ],
      },
    },
  ]);
});

test("a list is repeated `return` parameters, one per element", async () => {
  assert.deepEqual(params(await serialize("{1, 2, 3}")), [
    { name: "return", valueInteger: 1 },
    { name: "return", valueInteger: 2 },
    { name: "return", valueInteger: 3 },
  ]);
});

test("a tuple becomes parts named by field", async () => {
  assert.deepEqual(params(await serialize("Tuple { a: 1, b: 'x' }")), [
    {
      name: "return",
      part: [
        { name: "a", valueInteger: 1 },
        { name: "b", valueString: "x" },
      ],
    },
  ]);
});

test("a quantity uses valueQuantity with the UCUM code", async () => {
  assert.deepEqual(params(await serialize("5 'mg'")), [
    {
      name: "return",
      valueQuantity: { value: 5, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" },
    },
  ]);
});

test("a closed integer interval is a unity-coded Range declaring its cqlType", async () => {
  const p = firstParam(await serialize("Interval[1, 10]"));
  assert.deepEqual(p.extension, [
    {
      url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType",
      valueString: "Interval<System.Integer>",
    },
  ]);
  assert.deepEqual(p.valueRange, {
    low: { value: 1, system: "http://unitsofmeasure.org", code: "1" },
    high: { value: 10, system: "http://unitsofmeasure.org", code: "1" },
  });
});

test("an open integer boundary is closed-normalized — presence means closed to the reader", async () => {
  const p = firstParam(await serialize("Interval[1, 10)"));
  assert.deepEqual((p.valueRange as { high: { value: number } }).high.value, 9);
});

test("a date result is valueDate in FHIR (not CQL literal) form", async () => {
  assert.deepEqual(params(await serialize("@2018-01-15")), [
    { name: "return", valueDate: "2018-01-15" },
  ]);
});

test("a datetime result is valueDateTime", async () => {
  const p = firstParam(await serialize("@2018-01-15T10:30:00.000"));
  assert.match(String(p.valueDateTime), /^2018-01-15T10:30:00/);
});

test("a datetime interval is a Period declaring its cqlType", async () => {
  const p = firstParam(await serialize("Interval[@2018-01-01T00:00:00.000, @2018-12-31T23:59:59.999]"));
  assert.deepEqual(p.extension, [
    {
      url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType",
      valueString: "Interval<System.DateTime>",
    },
  ]);
  const period = p.valuePeriod as { start: string; end: string };
  assert.match(period.start, /^2018-01-01T00:00:00/);
  assert.match(period.end, /^2018-12-31T23:59:59/);
});

test("INT32_MIN is still a valueInteger — the abs() shortcut was off by one at the bottom", async () => {
  assert.deepEqual(params(await serialize("-2147483648")), [
    { name: "return", valueInteger: -2147483648 },
  ]);
});

test("a tuple whose field names collide with interval flags is STILL a tuple", async () => {
  // cql-execution intervals and temporals are class instances; tuples are plain objects. Detection
  // must discriminate on that, or `Tuple { lowClosed: true, foo: 1 }` serializes as an empty Range
  // and silently DROPS foo (review finding).
  assert.deepEqual(params(await serialize("Tuple { lowClosed: true, foo: 1 }")), [
    {
      name: "return",
      part: [
        { name: "lowClosed", valueBoolean: true },
        { name: "foo", valueInteger: 1 },
      ],
    },
  ]);
});

test("a nested list nests under parts named `element`", async () => {
  assert.deepEqual(params(await serialize("{{1, 2}, {3}}")), [
    {
      name: "return",
      part: [
        { name: "element", valueInteger: 1 },
        { name: "element", valueInteger: 2 },
      ],
    },
    { name: "return", part: [{ name: "element", valueInteger: 3 }] },
  ]);
});

test("an open temporal boundary is closed-normalized via successor/predecessor (Codex P2)", async () => {
  const openHigh = firstParam(await serialize("Interval[@2018-01-01, @2018-01-05)"));
  assert.equal((openHigh.valuePeriod as { end: string }).end, "2018-01-04");
  const openLow = firstParam(await serialize("Interval(@2018-01-01, @2018-01-05]"));
  assert.equal((openLow.valuePeriod as { start: string }).start, "2018-01-02");
});

test("an open quantity-interval boundary is closed-normalized by the decimal step (Codex round 2)", async () => {
  // Quantities carry no successor()/predecessor() (probed), so the CQL Decimal step applies to the
  // value. Presence means closed to the reader, same as every other interval branch.
  const p = firstParam(await serialize("Interval[1 'mg', 10 'mg')"));
  const range = p.valueRange as { high: { value: number; code: string } };
  assert.equal(range.high.value, 9.99999999);
  assert.equal(range.high.code, "mg");
});

test("a ratio uses valueRatio with UCUM-coded quantities", async () => {
  assert.deepEqual(params(await serialize("1 'mg' : 2 'mL'")), [
    {
      name: "return",
      valueRatio: {
        numerator: { value: 1, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" },
        denominator: { value: 2, unit: "mL", system: "http://unitsofmeasure.org", code: "mL" },
      },
    },
  ]);
});

test("a time result is valueTime with no leading T", async () => {
  const p = firstParam(await serialize("@T10:30:00"));
  assert.match(String(p.valueTime), /^10:30:00/);
});

// ---- #482 / #488 — the declared result type from the compiled ELM ---------------------------------
//
// The engine's runtime numbers carry no static type, so the serializer's whole-number heuristic
// mislabels `Interval[1.0, 2.0)` as Integer (wrong closed-normalization step AND wrong label), and a
// Long that reaches JS as a plain number loses its identity. The translator stamps the define's
// static type when EnableResultTypes is on; the route threads it in. The declared type wins where it
// is authoritative (numeric point types, Long identity); the value flags keep deciding what only the
// runtime value knows (temporal point types); everything else falls back to the old heuristics.

test("#482 declaredResultType parses named, interval, and list-of-interval ELM result types", () => {
  assert.deepEqual(declaredResultType({ resultTypeName: "{urn:hl7-org:elm-types:r1}Long" }), {
    kind: "named",
    name: "Long",
  });
  assert.deepEqual(
    declaredResultType({
      resultTypeSpecifier: {
        type: "IntervalTypeSpecifier",
        pointType: { type: "NamedTypeSpecifier", name: "{urn:hl7-org:elm-types:r1}Decimal" },
      },
    }),
    { kind: "interval", point: { kind: "named", name: "Decimal" } },
  );
  assert.deepEqual(
    declaredResultType({
      resultTypeSpecifier: {
        type: "ListTypeSpecifier",
        elementType: {
          type: "IntervalTypeSpecifier",
          pointType: { type: "NamedTypeSpecifier", name: "{urn:hl7-org:elm-types:r1}Integer" },
        },
      },
    }),
    { kind: "list", element: { kind: "interval", point: { kind: "named", name: "Integer" } } },
  );
  // Absent, foreign-namespace, and choice types all derive nothing — the fallback heuristics apply.
  assert.equal(declaredResultType({}), null);
  assert.equal(declaredResultType(undefined), null);
  assert.equal(declaredResultType({ resultTypeName: "{http://hl7.org/fhir}Patient" }), null);
  assert.equal(declaredResultType({ resultTypeSpecifier: { type: "ChoiceTypeSpecifier" } }), null);
});

test("#482 an open Decimal interval with whole-number boundaries takes its point type from the ELM", async () => {
  // The heuristic reads {1, 2} as Integer: label Interval<System.Integer>, high closed-normalized to
  // 1 — a boundary whose true coverage extends to 1.99999999. The declared type is the truth.
  const p = firstParam(await serializeTyped("Interval[1.0, 2.0)"));
  assert.deepEqual(p.extension, [
    { url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "Interval<System.Decimal>" },
  ]);
  const range = p.valueRange as { low: { value: number }; high: { value: number } };
  assert.equal(range.low.value, 1);
  assert.equal(range.high.value, 1.99999999);
});

test("#482 a closed whole-valued Decimal interval is labeled Decimal (no boundary movement)", async () => {
  const p = firstParam(await serializeTyped("Interval[1.0, 3.0]"));
  assert.deepEqual(p.extension, [
    { url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "Interval<System.Decimal>" },
  ]);
  const range = p.valueRange as { low: { value: number }; high: { value: number } };
  assert.equal(range.low.value, 1);
  assert.equal(range.high.value, 3);
});

test("#482 a list of Decimal intervals threads the element type to every element", async () => {
  const out = params(await serializeTyped("{ Interval[1.0, 2.0), Interval[3.0, 4.0] }"));
  assert.equal(out.length, 2);
  for (const p of out) {
    assert.deepEqual(p.extension, [
      { url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "Interval<System.Decimal>" },
    ]);
  }
  assert.equal(((out[0] as { valueRange?: { high: { value: number } } }).valueRange as { high: { value: number } }).high.value, 1.99999999);
});

test("#482 a declared Integer interval still closed-normalizes by 1", async () => {
  const p = firstParam(await serializeTyped("Interval[1, 4)"));
  assert.deepEqual(p.extension, [
    { url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "Interval<System.Integer>" },
  ]);
  assert.equal((p.valueRange as { high: { value: number } }).high.value, 3);
});

test("#488 a Long result keeps its identity: valueString integer literal + System.Long cqlType", async () => {
  // FHIR R4 has no integer64; the runner's longEquals reads a valueString and compares by BigInt.
  // The engine hands `-1L` over as a plain JS number, so only the declared type can say it was a Long.
  assert.deepEqual(params(await serializeTyped("-1L")), [
    {
      name: "return",
      extension: [{ url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "System.Long" }],
      valueString: "-1",
    },
  ]);
});

test("#488 a Long literal the engine returns as a string stays byte-exact", async () => {
  // cql-execution has no Long runtime type: a Long literal passes through as its STRING. The
  // serializer must ship those digits untouched — this is the case where a Number round-trip would
  // destroy the value.
  assert.deepEqual(params(await serializeTyped("9223372036854775807L")), [
    {
      name: "return",
      extension: [{ url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "System.Long" }],
      valueString: "9223372036854775807",
    },
  ]);
});

test("#488 documented limit: the engine's own Long arithmetic is lossy; the serializer adds no loss", async () => {
  // `-9223372036854775807L` reaches the serializer as the number -9223372036854776000 — cql-execution
  // coerces the Long literal string through Number in Negate (the upstream Long gap, ADR-060). The
  // serializer ships exactly what it was given, as a Long. If this assertion ever fails with the TRUE
  // value, upstream fixed Long support — celebrate and update it.
  assert.deepEqual(params(await serializeTyped("-9223372036854775807L")), [
    {
      name: "return",
      extension: [{ url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "System.Long" }],
      valueString: "-9223372036854776000",
    },
  ]);
});

test("#482 the untyped path is unchanged — no declared type means the old heuristics", async () => {
  // Every pre-#482 test in this file calls resultToParameters(value) with no type; this pins the
  // fallback explicitly for the interval case the declared type would relabel.
  const p = firstParam(await serialize("Interval[1.0, 2.0)"));
  assert.deepEqual(p.extension, [
    { url: "http://hl7.org/fhir/StructureDefinition/cqf-cqlType", valueString: "Interval<System.Integer>" },
  ]);
});

test("an evaluation error is the `evaluation error` parameter carrying an OperationOutcome", () => {
  const out = evaluationErrorParameters("boom");
  const p = firstParam(out);
  assert.equal(p.name, "evaluation error");
  const resource = p.resource as { resourceType: string; issue: { severity: string; diagnostics: string }[] };
  assert.equal(resource.resourceType, "OperationOutcome");
  const issue = resource.issue[0];
  assert.ok(issue, "the OperationOutcome must carry an issue");
  assert.equal(issue.severity, "error");
  assert.equal(issue.diagnostics, "boom");
});
