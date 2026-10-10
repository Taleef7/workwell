/**
 * Edit cases on a synthetic single-rate Measure (CMS130's shape: four populations, one group) and a
 * five-population one (a denominator exception, as CMS2 declares). The file format is strict, both lists
 * share the patients but not their expectations, and the runner counts agreements rather than assuming
 * them — the MADiE harness hands back a case it could not score with no agreement at all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  declaredPopulations,
  discriminatingCases,
  editCaseSetProblems,
  officialCasesFor,
  parseEditCases,
  renderRates,
  runEditCases,
  supplementProblems,
  supplementValueSets,
} from "./edit-cases.ts";
import {
  supplementFor,
  type RunOfficialMeasureOptions,
  classifyPopulationAgreement,
  type FhirBundle,
  type LoadedOfficialMeasure,
  type OfficialCaseResult,
  type OfficialMeasureRun,
  type PopulationCode,
  type PopulationCounts,
} from "./official-cases.ts";

const FOUR: PopulationCode[] = ["initial-population", "denominator", "denominator-exclusion", "numerator"];
const population = (code: string) => ({ code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/measure-population", code }] } });
const measureBundle = (groups: string[][]): FhirBundle => ({
  resourceType: "Bundle",
  entry: [
    { resource: { resourceType: "Measure", url: "urn:test", group: groups.map((codes) => ({ population: [...codes.map(population), population("measure-observation")] })) } },
    { resource: { resourceType: "ValueSet", id: "vs" } },
  ],
});
const SINGLE = measureBundle([FOUR]);
const PERIOD = { start: "2026-01-01", end: "2026-12-31" };
const rate = (denex: 0 | 1) => ({ "initial-population": 1, denominator: 1, "denominator-exclusion": denex, numerator: 0 });
const caseOf = (id: string, cms: unknown, translation: unknown, resources: unknown[] = [{ resourceType: "Patient", id: `p-${id}` }]) => ({
  id,
  description: `case ${id}`,
  resources,
  expected: { cms, translation },
});
const FILE = {
  measurementPeriod: PERIOD,
  cases: [
    caseOf("1", rate(0), rate(1), [{ resourceType: "Patient", id: "p-1" }, { resourceType: "Condition", id: "c-1" }]),
    caseOf("3", rate(0), rate(0)),
  ],
};

test("the populations each Measure group declares, in harness order, ignoring the ones it does not compare", () => {
  assert.deepEqual(declaredPopulations(SINGLE), [FOUR]);
  assert.deepEqual(declaredPopulations(measureBundle([["numerator", "initial-population", "denominator-exception", "denominator"]])), [["initial-population", "denominator", "numerator", "denominator-exception"]]);
  assert.throws(() => declaredPopulations({ entry: [] } as never), /no Measure/);
  assert.throws(() => declaredPopulations(measureBundle([])), /declares no group/);
  assert.throws(() => declaredPopulations(measureBundle([["measure-observation"]])), /group 1 declares no population the harness compares/);
});

test("a file is parsed into both expectations, each stating every declared population", () => {
  const set = parseEditCases(FILE, [FOUR]);
  assert.deepEqual(set.measurementPeriod, PERIOD);
  assert.equal(set.cases.length, 2);
  assert.equal(set.cases[0]!.patientId, "p-1");
  assert.deepEqual(set.cases[0]!.expected.translation, [{ ...rate(1), "denominator-exception": 0 }], "an undeclared population is 0, never stated");
  assert.deepEqual(discriminatingCases(set).map((c) => c.id), ["1"]);
  // An array is accepted for one rate too; several rates must be an array, one per group.
  assert.equal(parseEditCases({ ...FILE, cases: [caseOf("1", [rate(0)], [rate(1)])] }, [FOUR]).cases.length, 1);
  const two = parseEditCases({ ...FILE, cases: [caseOf("1", [rate(0), rate(0)], [rate(1), rate(0)])] }, [FOUR, FOUR]);
  assert.equal(two.cases[0]!.expected.cms.length, 2);
  // A measure with a denominator exception must have it stated.
  const five: PopulationCode[] = [...FOUR, "denominator-exception"];
  assert.throws(() => parseEditCases(FILE, [five]), /expected\.cms must state denominator-exception as 0 or 1/);
  const excepted = parseEditCases({ ...FILE, cases: [caseOf("1", { ...rate(0), "denominator-exception": 1 }, { ...rate(1), "denominator-exception": 0 })] }, [five]);
  assert.equal(excepted.cases[0]!.expected.cms[0]!["denominator-exception"], 1);
});

test("anything a case would say less than it appears to is refused, by name", () => {
  const refusals: Array<[unknown, RegExp]> = [
    [[], /not a JSON object/],
    [{ ...FILE, note: "x" }, /unknown key\(s\) note/],
    [{ cases: [] }, /needs measurementPeriod/],
    [{ ...FILE, measurementPeriod: { ...PERIOD, timezone: "Z" } }, /measurementPeriod has unknown key\(s\) timezone/],
    [{ measurementPeriod: PERIOD }, /needs a cases array/],
    [{ ...FILE, cases: [{ ...caseOf("1", rate(0), rate(1)), id: "" }] }, /case 1 has no id/],
    [{ ...FILE, cases: [{ ...caseOf("1", rate(0), rate(1)), expectd: {} }] }, /case 1 has unknown key\(s\) expectd/],
    [{ ...FILE, cases: [caseOf("1", rate(0), rate(1)), caseOf("1", rate(0), rate(1), [{ resourceType: "Patient", id: "other" }])] }, /case 1 appears twice/],
    [{ ...FILE, cases: [{ ...caseOf("1", rate(0), rate(1)), description: " " }] }, /case 1 has no description/],
    [{ ...FILE, cases: [caseOf("1", rate(0), rate(1), [])] }, /case 1 has no resources/],
    [{ ...FILE, cases: [caseOf("1", rate(0), rate(1), [{ id: "x" }])] }, /case 1 resource 1 has no resourceType/],
    [{ ...FILE, cases: [caseOf("1", rate(0), rate(1), [{ resourceType: "Condition" }])] }, /case 1 needs exactly one Patient with an id, found 0/],
    [{ ...FILE, cases: [caseOf("1", rate(0), rate(1), [{ resourceType: "Patient", id: "a" }, { resourceType: "Patient", id: "b" }])] }, /found 2/],
    [{ ...FILE, cases: [caseOf("1", rate(0), rate(1)), caseOf("2", rate(0), rate(1), [{ resourceType: "Patient", id: "p-1" }])] }, /case 2 reuses Patient p-1/],
    [{ ...FILE, cases: [{ ...caseOf("1", rate(0), rate(1)), expected: { cms: rate(0) } }] }, /case 1 expected\.translation is not an object/],
    [{ ...FILE, cases: [{ ...caseOf("1", rate(0), rate(1)), expected: { cms: rate(0), translation: rate(1), both: 1 } }] }, /case 1 expected has unknown key\(s\) both/],
    [{ ...FILE, cases: [caseOf("1", { ...rate(0), numerator: 2 }, rate(1))] }, /expected\.cms must state numerator as 0 or 1/],
    [{ ...FILE, cases: [caseOf("1", { ...rate(0), "denominator-exception": 0 }, rate(1))] }, /expected\.cms has unknown key\(s\) denominator-exception/],
    [{ ...FILE, cases: [caseOf("1", [rate(0), rate(0)], rate(1))] }, /expected\.cms states 2 rate\(s\); the Measure has 1/],
  ];
  for (const [file, message] of refusals) assert.throws(() => parseEditCases(file, [FOUR]), message, String(message));
  // Two groups: a bare object no longer says which rate it means.
  assert.throws(() => parseEditCases(FILE, [FOUR, FOUR]), /must be an array of 2 rates, one per Measure group/);
});

test("the two lists share the patients, never the expectations or the bundles", () => {
  const set = parseEditCases(FILE, [FOUR]);
  const cms = officialCasesFor(set, "cms");
  const translation = officialCasesFor(set, "translation");
  assert.deepEqual(cms.map((c) => [c.uuid, c.patientId]), translation.map((c) => [c.uuid, c.patientId]));
  assert.equal(cms[0]!.expected!["denominator-exclusion"], 0);
  assert.equal(translation[0]!.expected!["denominator-exclusion"], 1);
  assert.deepEqual(cms[0]!.expectedRates, [cms[0]!.expected]);
  assert.deepEqual(cms[0]!.patientBundle, { resourceType: "Bundle", type: "collection", entry: FILE.cases[0]!.resources.map((resource) => ({ resource })) });
  assert.notEqual(cms[0]!.patientBundle!.entry[0]!.resource, translation[0]!.patientBundle!.entry[0]!.resource, "each run gets its own copy");
  assert.equal(renderRates(cms[0]!.expectedRates, [FOUR]), "IPP 1 DENOM 1 DENEX 0 NUMER 0");
  assert.equal(renderRates(undefined, [FOUR]), "no result");
});

test("a set that cannot test the edit is refused before anything runs", () => {
  const set = parseEditCases(FILE, [FOUR]);
  assert.deepEqual(editCaseSetProblems(set, PERIOD), []);
  assert.deepEqual(editCaseSetProblems({ ...set, cases: [] }, PERIOD), ["edit-cases.json holds no case"]);
  assert.match(editCaseSetProblems({ ...set, cases: [set.cases[1]!] }, PERIOD).join(), /none of the 1 edit case\(s\) expects a different answer/);
  assert.deepEqual(editCaseSetProblems(set, { start: "2025-01-01", end: "2025-12-31" }), [
    "edit-cases.json is written for 2026-01-01..2026-12-31, but the MADiE deck runs 2025-01-01..2025-12-31",
  ]);
});

// ---- the runner ---------------------------------------------------------------------------------------

const LOADED: LoadedOfficialMeasure = {
  measure: "cms130",
  measureName: "CMS",
  contentDir: "unused",
  measureBundle: SINGLE,
  cases: [],
  measurementPeriod: PERIOD,
  valueSets: { total: 1, expanded: 1, truncated: [] },
  valueSetResources: [],
};
const TRANSLATED: FhirBundle = { ...SINGLE, entry: [...SINGLE.entry, { resource: { resourceType: "Library", name: "Translated" } }] };
const full = (denex: 0 | 1): PopulationCounts => ({ ...rate(denex), "denominator-exception": 0 });

/**
 * The engine: case 1 is excluded on the translated bundle only, case 3 on neither. `skip` returns that
 * case unscored (what the harness does with a case missing `expected`); `drop` omits it.
 */
function engine(
  seen: Array<{ translated: boolean; ids: string[]; denex: number[] }>,
  over: { skip?: string; drop?: string; error?: string; retryOn?: "translated"; supplied?: string[]; dropSupplement?: boolean } = {},
) {
  return async (loaded: LoadedOfficialMeasure, options: RunOfficialMeasureOptions = {}): Promise<OfficialMeasureRun> => {
    const translated = loaded.measureBundle === TRANSLATED;
    // Which side got which supplement, as `side:url=code,code`; and what the real harness would record.
    for (const vs of (options.supplementalValueSets ?? []) as Array<{ url: string; expansion: { contains: Array<{ code: string }> } }>) {
      over.supplied?.push(`${translated ? "translation" : "cms"}:${vs.url}=${vs.expansion.contains.map((c) => c.code).join(",")}`);
    }
    const supplementedOids = over.dropSupplement ? [] : supplementFor(loaded, options.supplementalValueSets).map((vs) => String((vs as { url: string }).url));
    seen.push({ translated, ids: loaded.cases.map((c) => c.uuid), denex: loaded.cases.map((c) => c.expected!["denominator-exclusion"]) });
    const cases: OfficialCaseResult[] = loaded.cases
      .filter((c) => c.uuid !== over.drop)
      .map((c) => {
        if (c.uuid === over.skip) return { ...c };
        const actual = full(translated && c.uuid === "1" ? 1 : 0);
        return { ...c, actual, actualRates: [actual], agreement: classifyPopulationAgreement("cms130", c.uuid, c.expected!, actual, { expected: c.expectedRates!, actual: [actual] }) };
      });
    return {
      measure: "cms130",
      measureName: "CMS",
      measurementPeriod: loaded.measurementPeriod,
      valueSets: loaded.valueSets,
      valueSetMode: "measure-bundle",
      supplementedOids,
      trustMetaProfile: translated && over.retryOn === "translated",
      profileRetry: false,
      retrieveSignal: true,
      engineWarnings: 0,
      ...(over.error ? { calculationError: over.error } : {}),
      cases,
      summary: { total: cases.length, expectedAgreements: 0, referenceAgreements: 0, unexpectedMismatches: 0, errors: 0 },
    };
  };
}

const runWith = (over: Parameters<typeof engine>[1] = {}, set = parseEditCases(FILE, [FOUR])) => {
  const seen: Array<{ translated: boolean; ids: string[]; denex: number[] }> = [];
  return runEditCases({ set, loaded: LOADED, upstreamBundle: SINGLE, translatedBundle: TRANSLATED, runCases: engine(seen, over) }).then((outcome) => ({ outcome, seen }));
};

test("each logic runs with its own expectations, on the deck's value sets and period, and every case agrees", async () => {
  const { outcome, seen } = await runWith();
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual([outcome.total, outcome.discriminating], [2, 1]);
  assert.deepEqual(outcome.sides.map((s) => [s.side, s.agreeing, s.total]), [["cms", 2, 2], ["translation", 2, 2]]);
  assert.deepEqual(seen, [
    { translated: false, ids: ["1", "3"], denex: [0, 0] },
    { translated: true, ids: ["1", "3"], denex: [1, 0] },
  ]);
});

test("a case the harness could not score, one it never returned, and an engine error all fail by count", async () => {
  const skipped = await runWith({ skip: "3" });
  assert.deepEqual(skipped.outcome.problems, ["CMS's logic: 1/2 edit case(s) agree", "the translation: 1/2 edit case(s) agree"]);
  assert.deepEqual(skipped.outcome.sides[0]!.disagreements, ["edit case 3 on CMS's logic: expected IPP 1 DENOM 1 DENEX 0 NUMER 0; not scored (no agreement)"]);

  const dropped = await runWith({ drop: "1" });
  assert.ok(dropped.outcome.problems.includes("CMS's logic: 1 case result(s) for 2 edit case(s)"), dropped.outcome.problems.join("\n"));
  assert.ok(dropped.outcome.problems.includes("the translation: 1/2 edit case(s) agree"));

  const failed = await runWith({ error: "boom" });
  assert.ok(failed.outcome.problems.includes("CMS's logic: calculation error: boom"));

  const retried = await runWith({ retryOn: "translated" });
  assert.ok(retried.outcome.problems.includes("the profile retry ran on one side only"));
});

test("an edit that did not take fails on the discriminating case alone", async () => {
  // The file says case 1 is excluded by the translation; an engine that answers CMS's way there fails it.
  const { outcome } = await runWith({}, parseEditCases({ ...FILE, cases: [caseOf("1", rate(0), rate(0)), caseOf("3", rate(0), rate(1))] }, [FOUR]));
  assert.deepEqual(outcome.problems, ["the translation: 0/2 edit case(s) agree"]);
  assert.deepEqual(outcome.sides[1]!.disagreements, [
    "edit case 1 on the translation: expected IPP 1 DENOM 1 DENEX 0 NUMER 0; got IPP 1 DENOM 1 DENEX 1 NUMER 0",
    "edit case 3 on the translation: expected IPP 1 DENOM 1 DENEX 1 NUMER 0; got IPP 1 DENOM 1 DENEX 0 NUMER 0",
  ]);
});

test("nothing runs for a set that is refused", async () => {
  const set = parseEditCases(FILE, [FOUR]);
  const { outcome, seen } = await runWith({}, { ...set, measurementPeriod: { start: "2027-01-01", end: "2027-12-31" } });
  assert.equal(seen.length, 0);
  assert.deepEqual(outcome.sides, []);
  assert.match(outcome.problems.join(), /written for 2027-01-01\.\.2027-12-31/);
});

// ---- #782: supplemental value sets, the translation's side only --------------------------------------------

const VS = "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1003.1285";
const SUPPLEMENTED = { ...FILE, supplementalValueSets: { [VS]: [{ system: "http://snomed.info/sct", code: "S1" }, { system: "http://snomed.info/sct", code: "S2" }] } };

test("supplementalValueSets is parsed strictly, and must name exactly the value sets the translation adds", () => {
  const set = parseEditCases(SUPPLEMENTED, [FOUR]);
  assert.deepEqual(set.supplementalValueSets, SUPPLEMENTED.supplementalValueSets);
  assert.equal(parseEditCases(FILE, [FOUR]).supplementalValueSets, undefined, "absent when the file states none");
  assert.deepEqual(supplementValueSets(set), [
    { resourceType: "ValueSet", id: "2.16.840.1.113762.1.4.1003.1285", url: VS, status: "active", expansion: { timestamp: "2026-01-01T00:00:00Z", contains: SUPPLEMENTED.supplementalValueSets[VS] } },
  ]);
  const code = { system: "s", code: "c" };
  const refusals: Array<[unknown, RegExp]> = [
    [[code], /supplementalValueSets must be an object/],
    [{ "urn:oid:1.2.3": [code] }, /key 'urn:oid:1\.2\.3' is not a value-set canonical URL/],
    [{ [`${VS}|20260514`]: [code] }, /is not a value-set canonical URL \(…\/ValueSet\/<id>, no \|version\)/],
    [{ [VS]: [] }, /must be a non-empty array of \{ system, code \}/],
    [{ [VS]: [{ ...code, display: "d" }] }, /\[0\] has unknown key\(s\) display/],
    [{ [VS]: [{ system: "s" }] }, /\[0\] needs a system and a code/],
    [{ [VS]: [code, { ...code }] }, /\[1\] repeats s\|c/],
  ];
  for (const [supplement, message] of refusals) assert.throws(() => parseEditCases({ ...FILE, supplementalValueSets: supplement }, [FOUR]), message, String(message));

  assert.deepEqual(supplementProblems(set, [VS]), []);
  assert.deepEqual(supplementProblems(parseEditCases(FILE, [FOUR]), []), []);
  assert.deepEqual(supplementProblems(parseEditCases(FILE, [FOUR]), [VS]), [
    `supplementalValueSets states no codes for 1 value set(s) the translation declares and CMS's upstream bundle lacks: ${VS}`,
  ]);
  assert.deepEqual(supplementProblems(set, []), [`supplementalValueSets names 1 value set(s) that are not ones the translation declares and CMS's upstream bundle lacks: ${VS}`]);
  // Exact strings, as fqm compares them: the same OID under a version is another value set.
  assert.equal(supplementProblems(set, [`${VS}|20260514`]).length, 2);
});

test("the translation's side alone gets the stated codes, and must report having supplemented every one", async () => {
  const supplied: string[] = [];
  const { outcome } = await runWith({ supplied }, parseEditCases(SUPPLEMENTED, [FOUR]));
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual(supplied, [`translation:${VS}=S1,S2`], "CMS's side is given nothing");

  // A harness that supplemented nothing (narrowed it all away) fails the translation's side by name.
  const dropped = await runWith({ dropSupplement: true }, parseEditCases(SUPPLEMENTED, [FOUR]));
  assert.deepEqual(dropped.outcome.problems, [`the translation: the harness supplemented [], expected [${VS}]`]);

  // A set with no supplement passes no option at all.
  const none: string[] = [];
  assert.deepEqual((await runWith({ supplied: none })).outcome.problems, []);
  assert.deepEqual(none, []);
});
