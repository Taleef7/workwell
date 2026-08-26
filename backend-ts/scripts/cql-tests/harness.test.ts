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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestFile, ParseError, decodeXmlText } from "./parse-tests.ts";
import { skipDecision, UNCLAIMED_CAPABILITIES } from "./capabilities.ts";
import { buildLibrary } from "./run.ts";
import { validateUnit } from "../../src/measure/ucum.ts";
import {
  assertNonDegenerate,
  DegenerateRunError,
  improvements,
  notPassing,
  regressions,
  tally,
  type Baseline,
} from "./report.ts";
import type { CaseResult } from "./run.ts";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  // The form the chained-replace version got wrong: numeric refs were decoded FIRST, so `&#38;lt;`
  // became `&lt;` became `<`. A single pass cannot double-decode (review, #398).
  assert.equal(decodeXmlText("&#38;lt;"), "&lt;");
  assert.equal(decodeXmlText("&#x26;quot;"), "&quot;");
});

test("`invalid` is read from <expression>, not <test>, and carries no output", () => {
  const invalid = parseTestFile("FixtureTest.xml", FIXTURE).find((c) => c.name === "Invalid")!;
  assert.equal(invalid.invalid, "true");
  assert.equal(invalid.output, undefined);
});

test("a single-quoted attribute is read, not silently dropped", () => {
  // Dropping `invalid='true'` would turn an invalid case into a valid one with no expected output
  // (review, #398). The corpus uses double quotes today, so this safety was accidental.
  const xml = `<tests name="T"><group name="G"><test name='A'><expression invalid='true'>Ceiling(2147483648)</expression></test></group></tests>`;
  const [c] = parseTestFile("t.xml", xml);
  assert.equal(c!.name, "A");
  assert.equal(c!.invalid, "true");
});

test("a commented-out test is NOT parsed as live — upstream disabled it (runner-diff finding)", () => {
  // The corpus disables tests by wrapping them in XML comments (12 such in CqlTypesTest +
  // CqlDateTimeOperatorsTest at the current pin). cql-tests-runner's parser respects comments;
  // a regex reader that matches through `<!-- -->` grades cases upstream deliberately turned off,
  // which is how ADR-060's "1,835 cases" silently included 12 dead ones (true count 1,823).
  const xml = `<tests name="T"><group name="G">
    <test name="Live"><expression>1</expression><output>1</output></test>
    <!-- REPLACED: <test name="Dead"><expression>2</expression><output>2</output></test> -->
    <!-- <test name="AlsoDead">
      <expression>3</expression>
      <output>3</output>
    </test> -->
  </group></tests>`;
  const cases = parseTestFile("t.xml", xml);
  assert.deepEqual(cases.map((c) => c.name), ["Live"], "commented-out tests must not be graded");
});

test("a commented-out GROUP disappears whole, and comments cannot resurrect via nesting", () => {
  const xml = `<tests name="T"><group name="G">
    <test name="Live"><expression>1</expression><output>1</output></test>
  </group><!-- <group name="Dead"><test name="X"><expression>9</expression><output>9</output></test></group> --></tests>`;
  const cases = parseTestFile("t.xml", xml);
  assert.deepEqual(cases.map((c) => c.name), ["Live"]);
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
  assert.equal(UNCLAIMED_CAPABILITIES.size, 0, "UNCLAIMED_CAPABILITIES must stay empty — adding one needs its own PR");
  assert.deepEqual(skipDecision(["arithmetic-operators", "system.long"]), { skip: false });

  // Drive the REAL function against a populated map. A first cut re-implemented the loop here and
  // asserted against the re-implementation, which could not have caught a bug in `skipDecision` — the
  // vacuous-guard shape, in the test written to argue against it (review, #398).
  const fake: ReadonlyMap<string, string> = new Map([["system.long", "hypothetical"]]);
  assert.deepEqual(skipDecision(["arithmetic-operators", "system.long"], fake), {
    skip: true,
    capability: "system.long",
    reason: "hypothetical",
  });
  assert.deepEqual(skipDecision(["arithmetic-operators"], fake), { skip: false });
});

test("every quantity unit the real corpus uses validates — derived, not asserted", () => {
  // The scope claim in `ucum.ts` was wrong by 3× when written by hand (review, #398). Walking the corpus
  // makes it self-maintaining: if upstream adds a unit our table does not know, this fails instead of the
  // number silently shifting into `translation-error`.
  const dir = path.join(BACKEND, ".cql-tests", "tests", "cql");
  if (!existsSync(dir)) return; // corpus not fetched — the CI job fetches it; a local run stays green
  const units = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".xml"))) {
    const xml = readFileSync(path.join(dir, f), "utf8");
    // Unit-shaped only: the same quote form also encloses code-system names and display strings, which
    // are not units and must not be held to UCUM.
    for (const m of xml.matchAll(/[0-9]\s*'([^']{1,40})'/g)) {
      if (/^[^\s,"]+$/.test(m[1]!)) units.add(m[1]!);
    }
  }
  assert.ok(units.size >= 15, `found only ${units.size} distinct units — the sweep is not reaching the corpus`);
  const rejected = [...units].filter((u) => validateUnit(u) !== null);
  assert.deepEqual(rejected, [], "every unit the corpus uses must validate, or the run misreports it");
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

test("the baseline check catches a WITHIN-FILE swap that leaves every tally unchanged", () => {
  // The defect this test exists for (review, #398): the first cut keyed the baseline per FILE, so one
  // case going pass→fail while another in the SAME file went fail→pass left `pass` and `fail` identical
  // and CI green. That is the "trade 30 passes for 30 different ones" hazard — the one that ruled out a
  // bare threshold — surviving one level down.
  const a1 = result({ file: "A.xml", name: "T1" });
  const a2 = result({ file: "A.xml", name: "T2", outcome: "fail" });
  const before = [a1, a2];

  const baseline: Baseline = {
    pinned: "abc",
    total: 2,
    counts: tally(before),
    perFile: { "A.xml": tally(before) },
    notPassing: notPassing(before),
    gradedInJs: 0,
  };
  assert.deepEqual(Object.keys(baseline.notPassing), ["A.xml/G/T2"], "only non-passing cases are stored");
  assert.deepEqual(regressions(before, baseline), [], "an unchanged run is clean");

  // The swap: T1 breaks, T2 is fixed. Per-file tallies are IDENTICAL — 1 pass, 1 fail either way.
  const swapped = [result({ file: "A.xml", name: "T1", outcome: "fail" }), result({ file: "A.xml", name: "T2" })];
  assert.deepEqual(tally(swapped), tally(before), "the tallies really are identical — that is the point");
  const regs = regressions(swapped, baseline);
  assert.ok(
    regs.some((r) => r.includes("A.xml/G/T1")),
    `the swap must be caught per case, got ${JSON.stringify(regs)}`,
  );
  assert.deepEqual(improvements(swapped, baseline), ["A.xml/G/T2: fail → pass"]);
});

test("a case that changes between non-passing outcomes is reported, and one that vanishes is a regression", () => {
  const before = [result({ name: "T1", outcome: "fail" })];
  const baseline: Baseline = {
    pinned: "abc",
    total: 1,
    counts: tally(before),
    perFile: { "A.xml": tally(before) },
    notPassing: notPassing(before),
    gradedInJs: 0,
  };
  // fail → translation-error is not a loss, but the evidence doc enumerates these buckets, so drift
  // between them must not be silent.
  assert.ok(
    regressions([result({ name: "T1", outcome: "translation-error" })], baseline).some((r) =>
      r.includes("outcome changed"),
    ),
  );
  // A case in the baseline that did not run at all is a hole in the corpus, never an improvement.
  assert.ok(regressions([], baseline).some((r) => r.includes("did not run")));
});
