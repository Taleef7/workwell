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
import { resultToParameters, evaluationErrorParameters } from "./cql-result-parameters.ts";

async function evalExpr(expression: string): Promise<unknown> {
  const compiled = compileCql(`library T version '1.0.0'\ndefine Result: ${expression}\n`);
  assert.ok(compiled.ok, `expression should compile: ${expression}`);
  const results = await evaluateExpressions((compiled as { elm: unknown }).elm);
  return (results as Record<string, unknown>).Result;
}

async function serialize(expression: string) {
  return resultToParameters(await evalExpr(expression));
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

test("a time result is valueTime with no leading T", async () => {
  const p = firstParam(await serialize("@T10:30:00"));
  assert.match(String(p.valueTime), /^10:30:00/);
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
