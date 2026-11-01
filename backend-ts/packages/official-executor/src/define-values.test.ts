/**
 * `renderCqlValue` (#875) against the values fqm's debug output really holds: cql-execution's own types
 * (resolved through fqm-execution, the version it runs) and cql-exec-fhir's wrapped FHIR resources.
 *   node --import tsx --test packages/official-executor/src/define-values.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import cqlExecFhir from "cql-exec-fhir";
import { DEFINE_VALUE_MAX_BYTES, renderCqlValue } from "./index.ts";

// cql-execution is fqm's dependency, not this package's: load the copy fqm itself evaluates with.
const fqmRequire = createRequire(createRequire(import.meta.url).resolve("fqm-execution/package.json"));
const cql = fqmRequire("cql-execution") as Record<string, new (...args: never[]) => unknown> & {
  DateTime: { parse(text: string): unknown };
  Date: { parse(text: string): unknown };
};
const fhir = (cqlExecFhir as unknown as { FHIRWrapper: { FHIRv401(): { wrap(json: unknown, type?: string): unknown } } }).FHIRWrapper.FHIRv401();
const make = <T>(name: string, ...args: unknown[]): T => new (cql[name] as unknown as new (...a: unknown[]) => T)(...args);

test("nothing to show is null: null, undefined and an empty list", () => {
  assert.equal(renderCqlValue(null), null);
  assert.equal(renderCqlValue(undefined), null);
  assert.equal(renderCqlValue([]), null);
});

test("System primitives as CQL holds them", () => {
  assert.equal(renderCqlValue(true), "true");
  assert.equal(renderCqlValue(false), "false", "false is a value, not nothing");
  assert.equal(renderCqlValue(7), "7");
  assert.equal(renderCqlValue("Positive"), "Positive");
});

test("dates keep CQL's own precision and offset", () => {
  assert.equal(renderCqlValue(cql.Date.parse("2026-02-03")), "2026-02-03");
  assert.equal(renderCqlValue(cql.Date.parse("2026-02")), "2026-02", "a month-precision date is not padded to a day");
  assert.equal(renderCqlValue(cql.DateTime.parse("2026-02-03T10:15:00.000-05:00")), "2026-02-03T10:15:00.000-05:00");
  assert.equal(renderCqlValue(cql.DateTime.parse("2026-02-03T23:30:00.000+10:00")), "2026-02-03T23:30:00.000+10:00", "never shifted to UTC");
});

test("intervals, quantities, ratios and uncertainties", () => {
  const low = cql.Date.parse("2026-01-01");
  const high = cql.Date.parse("2026-01-31");
  assert.equal(renderCqlValue(make("Interval", low, high, true, true)), "[2026-01-01, 2026-01-31]");
  assert.equal(renderCqlValue(make("Interval", low, high, true, false)), "[2026-01-01, 2026-01-31)");
  assert.equal(renderCqlValue(make("Interval", low, null, false, true)), "(2026-01-01, null]");
  assert.equal(renderCqlValue(make("Quantity", 9.6, "%")), "9.6 %");
  assert.equal(renderCqlValue(make("Quantity", 128, "mm[Hg]")), "128 mm[Hg]");
  assert.equal(renderCqlValue(make("Quantity", 3, "1")), "3", "the unity unit is not shown");
  assert.equal(renderCqlValue(make("Ratio", make("Quantity", 1, "1"), make("Quantity", 2, "1"))), "1:2");
});

test("codes and concepts as system|code (display)", () => {
  const a1c = make("Code", "4548-4", "http://loinc.org", undefined, "Hemoglobin A1c");
  assert.equal(renderCqlValue(a1c), "http://loinc.org|4548-4 (Hemoglobin A1c)");
  const bare = make("Code", "17856-6", "http://loinc.org");
  assert.equal(renderCqlValue(make("Concept", [a1c, bare])), "http://loinc.org|4548-4 (Hemoglobin A1c) / http://loinc.org|17856-6");
});

test("a FHIR resource is its type, id and every element it states by name; references and bookkeeping are left out", () => {
  const observation = fhir.wrap({
    resourceType: "Observation",
    id: "o1",
    meta: { profile: ["http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-observation-lab"] },
    identifier: [{ value: "mrn-1" }],
    status: "final",
    code: { coding: [{ system: "http://loinc.org", code: "4548-4", display: "Hemoglobin A1c" }] },
    subject: { reference: "Patient/p1" },
    effectiveDateTime: "2026-02-03",
    issued: "2026-02-04T09:00:00Z",
    valueQuantity: { value: 9.6, unit: "%", system: "http://unitsofmeasure.org", code: "%" },
    note: [{ text: "free text a patient might have said" }],
  });
  assert.equal(
    renderCqlValue(observation),
    "Observation/o1 {status=final; code=http://loinc.org|4548-4 (Hemoglobin A1c); effectiveDateTime=2026-02-03; " +
      "issued=2026-02-04T09:00:00Z; valueQuantity=9.6 %}",
    "both dates are shown by name: nothing here picks 'the' date",
  );
  const textOnly = fhir.wrap({ resourceType: "Condition", id: "c1", code: { text: "Major depression" } });
  assert.equal(renderCqlValue(textOnly), 'Condition/c1 {code="Major depression"}');
});

test("a Reference stated only by identifier or display is still a Reference, at any depth and in a mixed list", () => {
  const procedure = fhir.wrap({
    resourceType: "Procedure",
    id: "pr1",
    status: "completed",
    subject: { identifier: { system: "urn:mrn", value: "MRN-123" } },
    performer: [{ actor: { display: "Dr. Jane Roe" }, function: { text: "Surgeon" } }],
    reasonReference: [{ display: "a person's name" }, { reference: "Condition/c1" }],
    reasonCode: [{ text: "Screening" }, { display: "a mixed-in reference" }],
    performedDateTime: "2026-03-01",
  });
  const rendered = renderCqlValue(procedure)!;
  assert.equal(rendered, 'Procedure/pr1 {status=completed; performer={function="Surgeon"}; reasonCode="Screening"; performedDateTime=2026-03-01}');
  for (const leaked of ["MRN-123", "Jane Roe", "person's name", "mixed-in"]) assert.ok(!rendered.includes(leaked), leaked);
  assert.equal(renderCqlValue(fhir.wrap({ identifier: { value: "MRN-9" } }, "Reference")), "(a reference)", "a define whose value is a Reference");
});

test("text is well-formed and one line: an unpaired surrogate is U+FFFD, NEL and U+2028/9 are spaces", () => {
  const rendered = renderCqlValue(`high \ud800 low \udc00 pair \ud83d\ude00 nel\u0085ls\u2028ps\u2029end`)!;
  assert.equal(rendered, "high \ufffd low \ufffd pair \ud83d\ude00 nel ls ps end");
  assert.ok((rendered as unknown as { isWellFormed(): boolean }).isWellFormed());
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ rendered })));
});

test("a Tuple is each field by name; a list is its first three in CQL's order and its count", () => {
  assert.equal(renderCqlValue({ date: cql.Date.parse("2026-03-01"), result: "Positive" }), "{date=2026-03-01; result=Positive}");
  assert.equal(renderCqlValue([1, 2, 3]), "1 | 2 | 3");
  assert.equal(renderCqlValue([5, 4, 3, 2, 1]), "5 | 4 | 3 | … (5 in all)", "not sorted, not picked");
});

test("an unknown object type says so rather than guessing", () => {
  class Opaque {}
  assert.equal(renderCqlValue(new Opaque()), "<unrendered Opaque>");
});

test("a value that cannot be rendered never throws into the calculation, and nesting is bounded", () => {
  const hostile = { toString() { throw new Error("boom"); } };
  Object.setPrototypeOf(hostile, { isDate: true });
  assert.equal(renderCqlValue(hostile), "<unrendered: error>");
  const loop: unknown[] = [];
  loop.push(loop);
  assert.match(renderCqlValue(loop)!, /\[…\]/, "a list that holds itself stops at the depth bound");
});

test("control characters become one space, so a value is one line", () => {
  assert.equal(renderCqlValue("line one\r\nline two\tend"), "line one line two end");
});

test("a value is capped in UTF-8 bytes with a marker, never cutting a character", () => {
  const long = Array.from({ length: 3 }, () => "é".repeat(400));
  const rendered = renderCqlValue(long)!;
  assert.ok(Buffer.byteLength(rendered, "utf8") <= DEFINE_VALUE_MAX_BYTES, `${Buffer.byteLength(rendered, "utf8")} bytes`);
  assert.ok(rendered.endsWith("…[truncated]"));
  assert.ok(!rendered.includes("\ufffd"), "no broken character");
  assert.equal(renderCqlValue("short"), "short", "under the cap, untouched");
});
