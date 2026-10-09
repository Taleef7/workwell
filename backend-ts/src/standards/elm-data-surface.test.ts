/**
 * The data surface: what a compiled library reads, compared across two compiles. Every ELM here is a small
 * hand-written document in the translator's shape (no CMS CQL or ELM); the calibration against CMS's real
 * libraries is described in `elm-data-surface.ts`, and the builder's use of it in `build-derived.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { dataSurfaceDifferences, elmDataSurface } from "./elm-data-surface.ts";

const VS_A = "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.0.1";
const VS_B = "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.0.2";
const LOINC = "http://loinc.org";

const valueSetRef = (name: string, extra: Record<string, unknown> = {}) => ({ type: "ValueSetRef", name, preserve: true, ...extra });
const retrieve = (dataType: string, codes?: unknown, extra: Record<string, unknown> = {}) => ({
  type: "Retrieve",
  dataType: `{http://hl7.org/fhir}${dataType}`,
  templateId: `http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-${dataType.toLowerCase()}`,
  ...(codes === undefined ? {} : { codeProperty: "code", codeComparator: "in", codes }),
  include: [],
  codeFilter: [],
  dateFilter: [],
  otherFilter: [],
  ...extra,
});

/**
 * A library shaped like the edited define: "Has Condition" = exists (Condition in "Illness") where its
 * start is in a window, plus a patient retrieve, a code retrieve and a function holding another retrieve.
 */
function library(over: { where?: unknown; conditionCodes?: unknown; extraDefs?: unknown[]; valueSets?: unknown[]; codes?: unknown[] } = {}) {
  return {
    library: {
      identifier: { id: "Demo", version: "1.0.000" },
      codeSystems: { def: [{ name: "LOINC", id: LOINC, accessLevel: "Public" }] },
      valueSets: { def: over.valueSets ?? [{ name: "Illness", id: VS_A }, { name: "Frailty", id: VS_B }] },
      codes: { def: over.codes ?? [{ name: "Housing status", id: "71802-3", display: "Housing status", codeSystem: { name: "LOINC" } }] },
      statements: {
        def: [
          { name: "Patient", expression: retrieve("Patient") },
          {
            name: "Has Condition",
            expression: {
              type: "Exists",
              operand: {
                type: "Query",
                source: [{ alias: "C", expression: retrieve("Condition", over.conditionCodes ?? valueSetRef("Illness")) }],
                where: over.where ?? { type: "In", precision: "Day", operand: [{ type: "Start", operand: { type: "AliasRef", name: "C" } }, { type: "Interval" }] },
              },
            },
          },
          { name: "Housing", expression: retrieve("Observation", { type: "ToList", operand: { type: "CodeRef", name: "Housing status" } }) },
          { type: "FunctionDef", name: "Frail", operand: [], expression: retrieve("DeviceRequest", valueSetRef("Frailty")) },
          ...(over.extraDefs ?? []),
        ],
      },
    },
  };
}

/** The "Has Condition" retrieve of a `library()`, to change in place. */
const conditionRetrieve = (lib: ReturnType<typeof library>) =>
  (lib.library.statements.def[1] as { expression: { operand: { source: Array<{ expression: Record<string, unknown> }> } } }).expression.operand.source[0]!.expression;

test("the surface is the declared value sets, codes and code systems, and every retrieve with what it names resolved", () => {
  const surface = elmDataSurface(library());
  assert.deepEqual(surface.valueSets, [VS_A, VS_B]);
  assert.deepEqual(surface.codes, [`71802-3|${LOINC}`]);
  assert.deepEqual(surface.codeSystems, [LOINC]);
  assert.equal(surface.retrieves.length, 4, "the function's retrieve counts as well as the defines'");
  const parsed = surface.retrieves.map((r) => JSON.parse(r) as Record<string, unknown>);
  const byType = (t: string) => parsed.find((r) => r["dataType"] === `{http://hl7.org/fhir}${t}`)!;
  assert.deepEqual(byType("Condition")["codes"], { valueSet: VS_A }, "a ValueSetRef is the value set's canonical");
  assert.deepEqual(byType("Observation")["codes"], { operand: { code: "71802-3", system: LOINC }, type: "ToList" }, "a CodeRef is its code and system");
  assert.deepEqual(byType("Patient"), { codeComparator: null, codeFilter: [], codeProperty: null, codes: null, dataType: "{http://hl7.org/fhir}Patient", templateId: "http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-patient" });
});

test("an edit that changes only how retrieved data is compared (starts during -> overlaps) leaves the surface as it was", () => {
  const overlaps = library({ where: { type: "Overlaps", precision: "Day", operand: [{ type: "AliasRef", name: "C" }, { type: "Interval" }] } });
  assert.deepEqual(elmDataSurface(overlaps), elmDataSurface(library()));
  assert.deepEqual(dataSurfaceDifferences(elmDataSurface(library()), elmDataSurface(overlaps)), []);
});

test("positions, CQL text and typing are not the surface, nor is how a reference is spelled", () => {
  const noisy = library({ conditionCodes: valueSetRef("Illness", { localId: "12", locator: "3:1-3:9", annotation: [{ s: {} }], resultTypeName: "{urn:hl7-org:elm-types:r1}ValueSet" }) });
  Object.assign(conditionRetrieve(noisy), { localId: "11", locator: "3:1-3:20", resultTypeSpecifier: { type: "ListTypeSpecifier" }, annotation: [] });
  assert.deepEqual(elmDataSurface(noisy), elmDataSurface(library()));
  // The same canonical declared under another name is the same value set.
  const renamed = library({ valueSets: [{ name: "Illness 2027", id: VS_A }, { name: "Frailty", id: VS_B }], conditionCodes: valueSetRef("Illness 2027") });
  assert.deepEqual(elmDataSurface(renamed), elmDataSurface(library()));
  // A retrieve inside an annotation is CQL narrative, not a fetch.
  const annotated = library();
  (annotated.library as Record<string, unknown>)["statements"] = { ...annotated.library.statements, annotation: [retrieve("Encounter", valueSetRef("Frailty"))] };
  assert.deepEqual(elmDataSurface(annotated), elmDataSurface(library()));
});

test("a retrieve of another value set, type, profile, code path or comparator is a difference, named by what moved", () => {
  const cms = elmDataSurface(library());
  const otherValueSet = elmDataSurface(library({ conditionCodes: valueSetRef("Frailty") }));
  assert.notDeepEqual(otherValueSet, cms);
  const [line, ...rest] = dataSurfaceDifferences(cms, otherValueSet);
  assert.deepEqual(rest, []);
  assert.match(line!, /^retrieves: only in CMS's 1 \(.*"valueSet":"http:\/\/cts\.nlm\.nih\.gov\/fhir\/ValueSet\/2\.16\.840\.1\.113883\.0\.1".*\), only in the translation's 1 \(.*0\.2"/);

  for (const [key, value] of [
    ["dataType", "{http://hl7.org/fhir}Observation"],
    ["templateId", "http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-condition-problems-health-concerns"],
    ["codeProperty", "category"],
    ["codeComparator", "~"],
    ["codeFilter", [{ property: "category", comparator: "in", value: valueSetRef("Frailty") }]],
  ] as const) {
    const changed = library();
    conditionRetrieve(changed)[key] = value;
    assert.ok(!isDeepStrictEqual(elmDataSurface(changed), cms), `a changed ${key} moves the surface`);
  }
  // A code test moved into codeFilter names the value set it reads, resolved like codes.
  const filtered = library();
  conditionRetrieve(filtered)["codeFilter"] = [{ property: "category", comparator: "in", value: valueSetRef("Frailty") }];
  assert.ok(elmDataSurface(filtered).retrieves.some((r) => r.includes(`"value":{"valueSet":"${VS_B}"}`)));
});

test("retrieves are a multiset: one more (or one fewer) equal retrieve is a difference", () => {
  const cms = elmDataSurface(library());
  const twice = elmDataSurface(library({ extraDefs: [{ name: "Again", expression: retrieve("Condition", valueSetRef("Illness")) }] }));
  assert.equal(twice.retrieves.length, 5);
  assert.deepEqual(dataSurfaceDifferences(cms, twice).length, 1);
  assert.match(dataSurfaceDifferences(cms, twice)[0]!, /^retrieves: only in the translation's 1 \(/);
  assert.match(dataSurfaceDifferences(twice, cms)[0]!, /^retrieves: only in CMS's 1 \(/);
});

test("the declarations are part of the surface: a value set, code or code system declared differently is a difference", () => {
  const cms = elmDataSurface(library());
  const unusedValueSet = elmDataSurface(library({ valueSets: [{ name: "Illness", id: VS_A }, { name: "Frailty", id: VS_B }, { name: "Unused", id: `${VS_B}9` }] }));
  assert.deepEqual(dataSurfaceDifferences(cms, unusedValueSet), [`valueSets: only in the translation's 1 (${VS_B}9)`]);
  const otherCode = elmDataSurface(library({ codes: [{ name: "Housing status", id: "71802-4", codeSystem: { name: "LOINC" } }] }));
  const lines = dataSurfaceDifferences(cms, otherCode);
  assert.equal(lines.length, 2, "the declaration and the retrieve that uses it");
  assert.match(lines[0]!, /^codes: only in CMS's 1 \(71802-3\|http:\/\/loinc\.org\), only in the translation's 1 \(71802-4\|http:\/\/loinc\.org\)$/);
  assert.match(lines[1]!, /^retrieves: /);
});

test("a reference into another library is recorded by its alias and name; a local one that names nothing is refused", () => {
  const foreign = elmDataSurface(library({ conditionCodes: valueSetRef("Illness", { libraryName: "Common" }) }));
  assert.ok(foreign.retrieves.some((r) => r.includes(`"codes":{"valueSetRef":"Common:Illness"}`)));
  const otherAlias = elmDataSurface(library({ conditionCodes: valueSetRef("Illness", { libraryName: "Shared" }) }));
  assert.equal(dataSurfaceDifferences(foreign, otherAlias).length, 1);
  const foreignCode = elmDataSurface(library({ codes: [{ name: "Housing status", id: "71802-3", codeSystem: { name: "LOINC", libraryName: "Common" } }] }));
  assert.deepEqual(foreignCode.codes, ["71802-3|Common:LOINC"]);

  assert.throws(() => elmDataSurface(library({ conditionCodes: valueSetRef("Nowhere") })), /ELM library Demo 1\.0\.000: a retrieve names value set 'Nowhere', which it does not declare/);
  assert.throws(
    () => elmDataSurface(library({ conditionCodes: { type: "CodeRef", name: "Nowhere" } })),
    /ELM library Demo 1\.0\.000: a retrieve names code 'Nowhere', which it does not declare/,
  );
  const housing = { name: "Housing status", id: "71802-3", codeSystem: { name: "LOINC" } };
  assert.throws(
    () => elmDataSurface(library({ codes: [housing, { name: "X", id: "1", codeSystem: { name: "SNOMEDCT" } }] })),
    /code 'X' names code system 'SNOMEDCT', which it does not declare/,
  );
  assert.throws(() => elmDataSurface({ notALibrary: true }), /not an ELM document/);
});

test("a library that reads nothing has an empty surface, and equal surfaces have no differences", () => {
  const empty = elmDataSurface({ library: { identifier: { id: "Helpers", version: "1" }, statements: { def: [{ name: "One", expression: { type: "Literal", value: "1" } }] } } });
  assert.deepEqual(empty, { valueSets: [], codes: [], codeSystems: [], retrieves: [] });
  assert.deepEqual(dataSurfaceDifferences(empty, empty), []);
});
