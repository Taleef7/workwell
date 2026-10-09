/**
 * The calibration gate, on synthetic runs: it must see a changed status, rate, stratifier or define VALUE
 * (not just fqm's truthiness label), never pass a run whose values went missing, refuse bad arguments,
 * and — through `main()` — fail when the run it is shown is not running our ELM. The real decks run in CI
 * (`pnpm test:compiled-cases`); this pins what "agree" means without them.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoadedOfficialMeasure, OfficialMeasureRun, PopulationCounts, RunOfficialMeasureOptions } from "../../standards/official-cases.ts";
import { compileLibrarySet, loadQiCoreModelInfos, CMS_TRANSLATOR_OPTIONS } from "../../standards/qicore-compile.ts";
import {
  COMPILED_GATE_MEASURES,
  CompiledCasesUsageError,
  breakInitialPopulation,
  canonicalValue,
  compareRuns,
  main,
  parseArgs,
  statementsByPatient,
  type CompiledCasesDeps,
} from "./compiled-cases.ts";

const counts = (ipp: number, numer: number): PopulationCounts => ({
  "initial-population": ipp,
  denominator: ipp,
  "denominator-exclusion": 0,
  numerator: numer,
  "denominator-exception": 0,
});

function run(numer: number, status: "expected-agreement" | "mismatch" = "expected-agreement", ipp = 1): OfficialMeasureRun {
  return {
    measure: "cms137",
    measureName: "M",
    measurementPeriod: { start: "2026-01-01", end: "2026-12-31" },
    valueSets: { total: 0, expanded: 0, truncated: [] },
    valueSetMode: "measure-bundle",
    supplementedOids: [],
    trustMetaProfile: false,
    profileRetry: false,
    retrieveSignal: true,
    engineWarnings: 0,
    cases: [
      { uuid: "u1", name: "n", title: "t", series: "s", description: "d", patientId: "p1", actualRates: [counts(ipp, numer)], agreement: { pass: status !== "mismatch", status, differences: [] } },
    ],
    summary: { total: 1, expectedAgreements: status === "mismatch" ? 0 : 1, referenceAgreements: 0, unexpectedMismatches: status === "mismatch" ? 1 : 0, errors: 0 },
  };
}

class Code {
  constructor(
    readonly code: string,
    readonly system: string,
  ) {}
}

const output = (numerator: unknown, strata: unknown = true, sex: unknown = new Code("248152002", "http://snomed.info/sct")) => ({
  results: [
    {
      patientId: "p1",
      detailedResults: [
        {
          statementResults: [
            { libraryName: "M", statementName: "Numerator", raw: numerator, final: numerator ? "TRUE" : "FALSE", relevance: "TRUE" },
            { libraryName: "M", statementName: "SDE Sex", raw: sex, final: "NA", relevance: "NA" },
            { libraryName: "M", statementName: "Helper", isFunction: true, final: "NA", relevance: "NA" },
          ],
          stratifierResults: [{ strataId: "s1", result: strata }],
        },
      ],
    },
  ],
});

test("a define's value is compared, not just fqm's truthiness label", () => {
  // Two Codes, both NA-labelled: only the value tells them apart. toString() would render both as
  // "[object Object]", which is why the canonical form uses the fields.
  assert.notEqual(canonicalValue(new Code("248152002", "s")), canonicalValue(new Code("248153007", "s")));
  assert.equal(canonicalValue({ _json: { resourceType: "Patient", id: "p" } }), '{"resourceType":"Patient","id":"p"}');
  assert.equal(canonicalValue({ b: 1, a: 2 }), canonicalValue({ a: 2, b: 1 }));
  const up = { run: run(1), output: output(true) };
  const c = compareRuns("cms137", up, { run: run(1), output: output(true, true, new Code("248153007", "http://snomed.info/sct")) });
  assert.equal(c.statementsDiffering, 1);
  assert.match(c.samples.join("\n"), /SDE Sex/);
});

test("every differing define value is returned, uncapped, with each side's compared string", () => {
  // Twenty defines that differ on one patient, plus one only CMS's run reports and one only ours does:
  // more than the 15 samples, so a list built from the samples would be short.
  const many = (side: "cms" | "ours") => ({
    results: [
      {
        patientId: "p1",
        detailedResults: [
          {
            statementResults: [
              ...Array.from({ length: 20 }, (_, i) => ({ libraryName: "M", statementName: `D${i}`, raw: side === "cms" ? i : -i - 1, final: "TRUE", relevance: "TRUE" })),
              { libraryName: "M", statementName: side === "cms" ? "Only CMS" : "Only ours", raw: true, final: "TRUE", relevance: "TRUE" },
              { libraryName: "M", statementName: "Same", raw: true, final: "TRUE", relevance: "TRUE" },
            ],
          },
        ],
      },
    ],
  });
  const c = compareRuns("cms137", { run: run(1), output: many("cms") }, { run: run(1), output: many("ours") });
  assert.equal(c.statementsDiffering, 22);
  assert.equal(c.statementDifferences.length, 22, "every difference, not the 15 samples");
  assert.equal(c.samples.length, 15, "the samples stay capped");
  assert.deepEqual(c.statementDifferences[3], { case: "u1", key: "g0|M.D3", cms: '3|"TRUE"|TRUE', ours: '-4|"TRUE"|TRUE' });
  assert.deepEqual(
    c.statementDifferences.filter((d) => d.cms === null || d.ours === null),
    [
      { case: "u1", key: "g0|M.Only CMS", cms: 'true|"TRUE"|TRUE', ours: null },
      { case: "u1", key: "g0|M.Only ours", cms: null, ours: 'true|"TRUE"|TRUE' },
    ],
  );
  assert.ok(!c.statementDifferences.some((d) => d.key === "g0|M.Same"));
  assert.deepEqual(compareRuns("cms137", { run: run(1), output: output(true) }, { run: run(1), output: output(true) }).statementDifferences, []);
});

test("functions are left out: they have no value, and overloads share a name", () => {
  const keys = [...(statementsByPatient(output(true)).get("p1")?.keys() ?? [])];
  assert.deepEqual(keys, ["g0|M.Numerator", "g0|M.SDE Sex"]);
});

test("identical runs agree on every axis", () => {
  const c = compareRuns("cms137", { run: run(1), output: output(true) }, { run: run(1), output: output(true) });
  assert.deepEqual([c.statusEqual, c.ratesEqual, c.stratifiersEqual, c.statementsCompared, c.statementsDiffering], [1, 1, 1, 2, 0]);
});

test("a changed rate, status, stratifier or value is seen", () => {
  const up = { run: run(1), output: output(true) };
  assert.equal(compareRuns("cms137", up, { run: run(0), output: output(true) }).ratesEqual, 0);
  assert.equal(compareRuns("cms137", up, { run: run(1, "mismatch"), output: output(true) }).statusEqual, 0);
  assert.equal(compareRuns("cms137", up, { run: run(1), output: output(true, false) }).stratifiersEqual, 0);
  assert.equal(compareRuns("cms137", up, { run: run(1), output: output(false) }).statementsDiffering, 1);
});

test("values missing or extra on our side are differences; two empty rate vectors are not agreement", () => {
  const missing = compareRuns("cms137", { run: run(1), output: output(true) }, { run: run(1), output: { results: [] } });
  assert.deepEqual([missing.statementsCompared, missing.statementsDiffering], [2, 2]);
  const extra = output(true);
  extra.results[0]?.detailedResults[0]?.statementResults.push({ libraryName: "M", statementName: "Extra", raw: 1, final: "TRUE", relevance: "TRUE" });
  assert.equal(compareRuns("cms137", { run: run(1), output: output(true) }, { run: run(1), output: extra }).statementsDiffering, 1);
  const empty = run(1);
  const noRates = { ...empty, cases: empty.cases.map((c) => ({ ...c, actualRates: [] })) };
  assert.equal(compareRuns("cms137", { run: noRates, output: output(true) }, { run: noRates, output: output(true) }).ratesEqual, 0);
});

test("breaking the Initial Population changes a copy, not the compiled library", () => {
  const compiled = [{ name: "M", version: "1", warnings: [], elm: { library: { identifier: { id: "M", version: "1" }, statements: { def: [{ name: "Initial Population", expression: { type: "ExpressionRef" } }] } } } }];
  const broken = breakInitialPopulation(compiled, "M");
  const def = (broken[0]?.elm.library.statements as { def: { expression: { value?: string } }[] }).def[0];
  assert.equal(def?.expression.value, "false");
  assert.equal((compiled[0]?.elm.library.statements as { def: { expression: { type: string } }[] }).def[0]?.expression.type, "ExpressionRef");
  assert.throws(() => breakInitialPopulation(compiled, "Other"), /no "Initial Population"/);
});

test("arguments: the six measures by default, a measure once, and refusals for anything else", () => {
  assert.deepEqual(parseArgs([]).measures, [...COMPILED_GATE_MEASURES]);
  assert.deepEqual(parseArgs(["--measure", "cms137", "--measure", "cms137"]).measures, ["cms137"]);
  assert.equal(parseArgs(["--signature-level", "Overloads"]).signatureLevel, "Overloads");
  assert.throws(() => parseArgs(["--measure", "cms68"]), CompiledCasesUsageError);
  assert.throws(() => parseArgs(["--signature-level", "None"]), CompiledCasesUsageError);
  assert.throws(() => parseArgs(["--content-dir"]), CompiledCasesUsageError);
});

// ---- main(), through its dependency seam -------------------------------------------------------------

const M_CQL = `library M version '1.0.0'
using QICore version '6.0.0'
context Patient
define "Initial Population": Patient.birthDate is not null
define "SDE Sex": Patient.gender
`;
const models = loadQiCoreModelInfos();
const [mElm] = compileLibrarySet([{ name: "M", version: "1.0.0", cql: M_CQL }], { modelInfos: models });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const optionsParameters = {
  resourceType: "Parameters",
  id: "options",
  parameter: [
    ...CMS_TRANSLATOR_OPTIONS.options.map((o) => ({ name: "option", valueString: o })),
    { name: "signatureLevel", valueString: "All" },
    { name: "compatibilityLevel", valueString: "1.5" },
    { name: "errorLevel", valueString: "Info" },
    { name: "validateUnits", valueBoolean: true },
  ],
};

function loaded(): LoadedOfficialMeasure {
  return {
    measure: "cms137",
    measureName: "M",
    contentDir: "/content",
    measureBundle: {
      resourceType: "Bundle",
      entry: [
        {
          resource: {
            resourceType: "Library",
            name: "M",
            version: "1.0.0",
            contained: [optionsParameters],
            content: [
              { contentType: "text/cql", data: b64(M_CQL) },
              { contentType: "application/elm+json", data: b64(JSON.stringify(mElm?.elm)) },
            ],
          },
        },
      ],
    },
    cases: [{ uuid: "u1", name: "n", title: "t", series: "s", description: "d", patientId: "p1" }],
    measurementPeriod: { start: "2026-01-01", end: "2026-12-31" },
    valueSets: { total: 0, expanded: 0, truncated: [] },
    valueSetResources: [],
  };
}

/**
 * A fake run that reads the ELM it is given, seeing only the breaks it is told to: a broken "Initial
 * Population" empties the population, a broken "SDE Sex" changes that define's value.
 */
function fakeRun(sees: { populations: boolean; values: boolean }) {
  return async (given: LoadedOfficialMeasure, options: RunOfficialMeasureOptions = {}): Promise<OfficialMeasureRun> => {
    const library = (given.measureBundle.entry ?? []).map((e) => e.resource as { content?: { contentType: string; data: string }[] })[0];
    const elm = JSON.parse(Buffer.from(library?.content?.find((c) => c.contentType === "application/elm+json")?.data ?? "", "base64").toString("utf8"));
    const defs = elm.library.statements.def as { name: string; expression: { type: string } }[];
    const ipBroken = sees.populations && defs.find((d) => d.name === "Initial Population")?.expression.type === "Literal";
    const sexBroken = sees.values && defs.find((d) => d.name === "SDE Sex")?.expression.type === "Literal";
    options.onOutput?.(output(!ipBroken, true, sexBroken ? "not the value" : new Code("248152002", "http://snomed.info/sct")) as never);
    return run(ipBroken ? 0 : 1, ipBroken ? "mismatch" : "expected-agreement", ipBroken ? 0 : 1);
  };
}
const honestRun = fakeRun({ populations: true, values: true });
/** Ignores the bundle — what a gate silently running CMS's ELM would see. */
const blindRun = fakeRun({ populations: false, values: false });

function deps(overrides: Partial<CompiledCasesDeps> = {}) {
  const lines: string[] = [];
  const base: Partial<CompiledCasesDeps> = {
    cwd: mkdtempSync(join(tmpdir(), "compiled-cases-")),
    load: () => loaded(),
    run: honestRun,
    verifyUpstream: () => {},
    modelInfos: () => models,
    pinnedStatements: { cms137: 2 },
    requiredCases: { cms137: 1 },
    log: (line) => lines.push(line),
    error: (line) => lines.push(`ERROR ${line}`),
  };
  return { lines, deps: { ...base, ...overrides } };
}

test("main: an honest run passes, and both non-vacuity checks fire", async () => {
  const { lines, deps: d } = deps();
  assert.equal(await main(["--measure", "cms137"], d), 0, lines.join("\n"));
  assert.match(lines.join("\n"), /1 case\(s\) move \(the gate runs our ELM\)/);
  assert.match(lines.join("\n"), /1 define value\(s\) differ \(the gate compares values\)/);
});

test("main: a run that is not looking at our ELM fails on both non-vacuity checks", async () => {
  const { lines, deps: d } = deps({ run: blindRun });
  assert.equal(await main(["--measure", "cms137"], d), 1);
  assert.match(lines.join("\n"), /not running our ELM/);
  assert.match(lines.join("\n"), /not comparing values/);
});

test("main: each non-vacuity check fails on its own", async () => {
  const valuesOnly = deps({ run: fakeRun({ populations: false, values: true }) });
  assert.equal(await main(["--measure", "cms137"], valuesOnly.deps), 1);
  assert.match(valuesOnly.lines.join("\n"), /not running our ELM/);
  assert.doesNotMatch(valuesOnly.lines.join("\n"), /not comparing values/);
  const populationsOnly = deps({ run: fakeRun({ populations: true, values: false }) });
  assert.equal(await main(["--measure", "cms137"], populationsOnly.deps), 1);
  assert.match(populationsOnly.lines.join("\n"), /not comparing values/);
  assert.doesNotMatch(populationsOnly.lines.join("\n"), /not running our ELM/);
});

test("main: a count that moved from its pin fails", async () => {
  const { lines, deps: d } = deps({ pinnedStatements: { cms137: 3 } });
  assert.equal(await main(["--measure", "cms137"], d), 1);
  assert.match(lines.join("\n"), /compared 2 define values, 3 pinned/);
});

test("main: an unverifiable upstream, an unusable model info or a bad argument exits 2", async () => {
  assert.equal(await main(["--measure", "cms137"], deps({ verifyUpstream: () => { throw new Error("hash differs"); } }).deps), 2);
  assert.equal(await main(["--measure", "cms137"], deps({ modelInfos: () => { throw new Error("refusing to compile against it"); } }).deps), 2);
  assert.equal(await main(["--measure", "cms68"], deps().deps), 2);
});

test("main: --elm-out writes each compiled library", async () => {
  const { deps: d } = deps();
  assert.equal(await main(["--measure", "cms137", "--elm-out", "elm"], d), 0);
  assert.ok(existsSync(join(d.cwd ?? "", "elm", "cms137", "M-1.0.0.json")));
});
