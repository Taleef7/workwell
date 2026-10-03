/**
 * The calibration gate's comparison, on synthetic runs: it must see a changed status, rate, stratifier or
 * statement result, never pass a run whose statements went missing, and refuse bad arguments. The real
 * decks run in CI (`pnpm test:compiled-cases`); this pins what "agree" means without them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { OfficialMeasureRun, PopulationCounts } from "../../standards/official-cases.ts";
import { COMPILED_GATE_MEASURES, CompiledCasesUsageError, breakInitialPopulation, compareRuns, parseArgs } from "./compiled-cases.ts";

const counts = (ipp: number, numer: number): PopulationCounts => ({
  "initial-population": ipp,
  denominator: ipp,
  "denominator-exclusion": 0,
  numerator: numer,
  "denominator-exception": 0,
});

function run(numer: number, status: "expected-agreement" | "mismatch" = "expected-agreement"): OfficialMeasureRun {
  return {
    measure: "cms125",
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
      { uuid: "u1", name: "n", title: "t", series: "s", description: "d", patientId: "p1", actualRates: [counts(1, numer)], agreement: { pass: status !== "mismatch", status, differences: [] } },
    ],
    summary: { total: 1, expectedAgreements: 1, referenceAgreements: 0, unexpectedMismatches: 0, errors: 0 },
  };
}

const output = (final: unknown, strata: unknown = true) => ({
  results: [
    {
      patientId: "p1",
      detailedResults: [
        {
          statementResults: [
            { libraryName: "M", statementName: "Numerator", final, relevance: "TRUE" },
            { libraryName: "M", statementName: "Denominator", final: "TRUE", relevance: "TRUE" },
          ],
          stratifierResults: [{ strataId: "s1", result: strata }],
        },
      ],
    },
  ],
});

test("identical runs agree on every axis", () => {
  const c = compareRuns("cms125", { run: run(1), output: output("TRUE") }, { run: run(1), output: output("TRUE") });
  assert.deepEqual([c.statusEqual, c.ratesEqual, c.stratifiersEqual, c.statementsCompared, c.statementsDiffering], [1, 1, 1, 2, 0]);
});

test("a changed rate, status, stratifier or statement is seen", () => {
  const up = { run: run(1), output: output("TRUE") };
  assert.equal(compareRuns("cms125", up, { run: run(0), output: output("TRUE") }).ratesEqual, 0);
  assert.equal(compareRuns("cms125", up, { run: run(1, "mismatch"), output: output("TRUE") }).statusEqual, 0);
  assert.equal(compareRuns("cms125", up, { run: run(1), output: output("TRUE", false) }).stratifiersEqual, 0);
  const statement = compareRuns("cms125", up, { run: run(1), output: output("FALSE") });
  assert.equal(statement.statementsDiffering, 1);
  assert.match(statement.samples.join("\n"), /M\.Numerator/);
});

test("statements missing on our side count as differences, never as agreement", () => {
  const c = compareRuns("cms125", { run: run(1), output: output("TRUE") }, { run: run(1), output: { results: [] } });
  assert.equal(c.statementsCompared, 2);
  assert.equal(c.statementsDiffering, 2);
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
