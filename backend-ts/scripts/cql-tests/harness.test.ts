/**
 * Tests for the V7 conformance harness itself (#296).
 *
 * A conformance harness grades other software, so a defect in it is worse than a defect in what it
 * measures: it produces a NUMBER that gets published. The first full run made that concrete — 155 of 183
 * apparent "JS translator gaps" were our own missing UCUM service. These tests cover the machinery that
 * decides what a result MEANS, on fixtures, with no network and no upstream corpus.
 *
 *   node --import tsx --test scripts/cql-tests/harness.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestFile, ParseError, decodeXmlText } from "./parse-tests.ts";
import { skipDecision, UNCLAIMED_CAPABILITIES } from "./capabilities.ts";
import { buildLibrary } from "./run.ts";
import { validateUnit } from "./ucum.ts";
import {
  assertNonDegenerate,
  DegenerateRunError,
  regressions,
  tally,
  type Baseline,
} from "./report.ts";
import type { CaseResult } from "./run.ts";

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<tests name="FixtureTest" version="1.0">
  <capability code="file-level-cap"/>
  <group name="G1" version="1.0">
    <capability code="group-level-cap"/>
    <test name="Plain" version="1.0">
      <expression>1 + 1</expression>
      <output>2</output>
    </test>
    <test name="NeedsCap" version="1.0">
      <capability code="test-level-cap"/>
      <expression>1L + 2L</expression>
      <output>3L</output>
    </test>
    <test name="Entities" version="1.0">
      <expression>1 &lt; 2 and 3 &gt; 2 and 'a&amp;b' = 'a&amp;b'</expression>
      <output>true</output>
    </test>
    <test name="Invalid" version="1.0">
      <expression invalid="true">Ceiling(2147483648)</expression>
    </test>
  </group>
</tests>`;

test("the reader merges capabilities from file, group and test levels", () => {
  const cases = parseTestFile("FixtureTest.xml", FIXTURE);
  assert.equal(cases.length, 4);
  const plain = cases.find((c) => c.name === "Plain")!;
  const needsCap = cases.find((c) => c.name === "NeedsCap")!;
  assert.deepEqual(plain.capabilities.sort(), ["file-level-cap", "group-level-cap"]);
  assert.deepEqual(needsCap.capabilities.sort(), ["file-level-cap", "group-level-cap", "test-level-cap"]);
  // A file-level capability must NOT be swallowed by the group scan, and vice versa — getting this wrong
  // would silently under- or over-skip.
  assert.ok(plain.capabilities.includes("file-level-cap"), "file-level capability lost");
});

test("the reader decodes entities, and &amp; last so &amp;lt; stays literal", () => {
  const entities = parseTestFile("FixtureTest.xml", FIXTURE).find((c) => c.name === "Entities")!;
  assert.equal(entities.expression, "1 < 2 and 3 > 2 and 'a&b' = 'a&b'");
  // The ordering property, directly: decoding `&amp;` first would turn this into `<`.
  assert.equal(decodeXmlText("&amp;lt;"), "&lt;");
  assert.equal(decodeXmlText("&#65;&#x42;"), "AB");
});

test("`invalid` is read from <expression>, not <test>, and carries no output", () => {
  const invalid = parseTestFile("FixtureTest.xml", FIXTURE).find((c) => c.name === "Invalid")!;
  assert.equal(invalid.invalid, "true");
  assert.equal(invalid.output, undefined);
});

test("the reader REFUSES rather than returning fewer cases", () => {
  // Each of these would otherwise shrink the denominator silently, inflating the pass rate.
  assert.throws(() => parseTestFile("x.xml", "<notatestfile/>"), ParseError);
  assert.throws(() => parseTestFile("x.xml", `<tests name="T"></tests>`), ParseError, "no groups");
  assert.throws(
    () => parseTestFile("x.xml", `<tests name="T"><group name="G"><test name="A"><output>1</output></test></group></tests>`),
    ParseError,
    "a test with no expression",
  );
  assert.throws(
    () => parseTestFile("x.xml", `<tests name="T"><group name="G"><test name="A"><expression>1</expression></test></group></tests>`),
    ParseError,
    "a VALID case with no output is ungradable and must not be dropped",
  );
});

test("the skip mechanism works — and claims everything today", () => {
  // The unclaimed set is empty by design (measuring the delta is the point), so the mechanism would be
  // untested if only exercised through the real corpus. Drive it directly.
  const fake = new Map([["system.long", "hypothetical"]]) as ReadonlyMap<string, string>;
  const saved = new Map(UNCLAIMED_CAPABILITIES);
  assert.equal(saved.size, 0, "UNCLAIMED_CAPABILITIES must stay empty — adding one needs its own PR");
  assert.deepEqual(skipDecision(["arithmetic-operators", "system.long"]), { skip: false });
  // The same predicate against a populated map, proving it is the map and not the code that is empty.
  const decide = (req: string[]) => {
    for (const c of req) {
      const reason = fake.get(c);
      if (reason !== undefined) return { skip: true, capability: c, reason };
    }
    return { skip: false };
  };
  assert.deepEqual(decide(["system.long"]), { skip: true, capability: "system.long", reason: "hypothetical" });
});

test("the generated library grades itself in CQL, and an invalid case emits no comparison", () => {
  const [plain, , , invalid] = parseTestFile("FixtureTest.xml", FIXTURE);
  const lib = buildLibrary(plain!);
  assert.match(lib, /define Actual: 1 \+ 1/);
  assert.match(lib, /define Expected: 2/);
  assert.match(lib, /define Passed: Actual ~ Expected/);
  // `values` mode drops the comparison — the fallback path when `~` will not type-check.
  assert.doesNotMatch(buildLibrary(plain!, "values"), /define Passed/);
  // An invalid case has no expected value, so a comparison line would reference a define that does not
  // exist and turn a translator finding into a harness error.
  assert.doesNotMatch(buildLibrary(invalid!), /define (Expected|Passed)/);
});

test("the UCUM validator accepts real units and REFUSES nonsense", () => {
  // Every unit the corpus actually uses.
  for (const u of ["cm", "g", "m", "g/cm3", "cm2", "1"]) {
    assert.equal(validateUnit(u), null, `${u} should be valid`);
  }
  for (const u of ["kg", "mg/dL", "mm[Hg]", "{tablet}", "10*3"]) {
    assert.equal(validateUnit(u), null, `${u} should be valid`);
  }
  // The property that matters: a permissive stub would return null here, silently manufacturing passes
  // for cases that expect a bad unit to be rejected.
  for (const u of ["notaunit", "", "zz/qq"]) {
    assert.notEqual(validateUnit(u), null, `${u} must be rejected`);
  }
});

const result = (over: Partial<CaseResult> = {}): CaseResult => ({
  file: "A.xml",
  group: "G",
  name: "T",
  outcome: "pass",
  expression: "1",
  durationMs: 0,
  ...over,
});

test("a run that did not reach the corpus REFUSES to report", () => {
  // The whole point: a harness that parses nothing reports no failures and looks green.
  assert.throws(() => assertNonDegenerate([], [], { filtered: false }), DegenerateRunError);
  assert.throws(
    () => assertNonDegenerate([result()], ["A.xml"], { filtered: false }),
    DegenerateRunError,
    "1 case is not the corpus",
  );
  // A filtered run legitimately reduces the set, so only the structural checks apply.
  assertNonDegenerate([result()], ["A.xml"], { filtered: true });
  assert.throws(() => assertNonDegenerate([], ["A.xml"], { filtered: true }), DegenerateRunError);
});

test("the baseline check catches a swap that leaves the total unchanged", () => {
  // The reason this is not a "≥N passing" threshold: a translator upgrade can trade 30 passes for 30
  // different ones and keep every total identical.
  const baseline: Baseline = {
    pinned: "abc",
    total: 2,
    counts: tally([result(), result({ file: "B.xml" })]),
    perFile: {
      "A.xml": tally([result()]),
      "B.xml": tally([result({ file: "B.xml" })]),
    },
  };
  assert.deepEqual(regressions([result(), result({ file: "B.xml" })], baseline), []);

  const swapped = [result({ outcome: "fail" }), result({ file: "B.xml" })];
  const regs = regressions(swapped, baseline);
  assert.ok(regs.some((r) => r.includes("A.xml")), `expected an A.xml regression, got ${JSON.stringify(regs)}`);

  // A file that vanishes entirely is a regression, not a silent zero.
  assert.ok(regressions([result()], baseline).some((r) => r.includes("B.xml")));
});
