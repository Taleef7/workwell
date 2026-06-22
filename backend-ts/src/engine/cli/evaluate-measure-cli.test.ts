/**
 * #72 / E2 headless CLI: arg-parsing units, golden regression over the
 * spike/synthetic corpus (via run()), and run()/evaluate() behavior. Evaluation
 * parity itself is covered by cql-execution-engine.test.ts.
 *   node --import tsx --test src/engine/cli/evaluate-measure-cli.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliUsageError, parseArgs, run, evaluate } from "./evaluate-measure-cli.ts";
import { MEASURES } from "../cql/measure-registry.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const fixture = (m: string, s: string) => path.join(SYNTH, m, `${s}.json`);
const EVAL = "2026-06-12";
const EXPECTED: Record<string, string> = {
  present_recent: "COMPLIANT",
  present_old: "OVERDUE",
  missing: "MISSING_DATA",
  excluded: "EXCLUDED",
};

// PERMANENT measures have no recency window — old doses stay COMPLIANT (the "compliant forever" proof).
const PERMANENT = new Set(["mmr", "varicella", "hepatitis_b_vaccination_series"]);
const expectedFor = (measureId: string, scenario: string): string =>
  PERMANENT.has(measureId) && scenario === "present_old" ? "COMPLIANT" : EXPECTED[scenario]!;

test("parseArgs: parses required + optional flags", () => {
  const a = parseArgs(["--patient", "b.json", "--measure", "audiogram", "--date", "2026-06-12", "--pretty"]);
  assert.deepEqual(a, { patient: "b.json", measure: "audiogram", date: "2026-06-12", pretty: true });
});

test("parseArgs: pretty defaults false, date optional", () => {
  const a = parseArgs(["--patient", "b.json", "--measure", "flu_vaccine"]);
  assert.equal(a.pretty, false);
  assert.equal(a.date, undefined);
});

test("parseArgs: missing --patient throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--measure", "audiogram"]), CliUsageError);
});

test("parseArgs: missing --measure throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--patient", "b.json"]), CliUsageError);
});

test("parseArgs: bad --date format throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--patient", "b.json", "--measure", "audiogram", "--date", "06/12/2026"]), CliUsageError);
});

test("parseArgs: unknown flag throws CliUsageError", () => {
  assert.throws(() => parseArgs(["--patient", "b.json", "--measure", "audiogram", "--bogus"]), CliUsageError);
});

test("run: evaluates a real bundle → MeasureOutcome shape", async () => {
  const outcome = await run(["--patient", fixture("audiogram", "present_recent"), "--measure", "audiogram", "--date", EVAL]);
  assert.equal(outcome.outcome, "COMPLIANT");
  assert.equal(outcome.measure, "Audiogram");
  assert.equal(outcome.subjectId, "audiogram-present_recent");
  assert.ok(outcome.evidence.expressionResults.some((r) => r.define === "Outcome Status"));
});

test("evaluate: unreadable bundle → CliUsageError", async () => {
  await assert.rejects(
    () => evaluate({ patient: path.join(SYNTH, "does-not-exist.json"), measure: "audiogram", pretty: false }),
    CliUsageError,
  );
});

test("evaluate: unknown measure → Error (not CliUsageError)", async () => {
  await assert.rejects(
    () => evaluate({ patient: fixture("audiogram", "present_recent"), measure: "nope", pretty: false }),
    /unknown measure 'nope'/,
  );
});

for (const measureId of Object.keys(MEASURES)) {
  test(`golden: CLI matches expected outcomes for ${measureId} (all scenarios)`, async () => {
    for (const scenario of Object.keys(EXPECTED)) {
      const expected = expectedFor(measureId, scenario);
      const outcome = await run(["--patient", fixture(measureId, scenario), "--measure", measureId, "--date", EVAL]);
      assert.equal(outcome.outcome, expected, `${measureId}/${scenario}`);
      assert.equal(outcome.measure, MEASURES[measureId]!.name);
    }
  });
}

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));
// Run the bin with the same node + tsx loader the repo's test script uses (no reliance on a tsx on PATH).
const runCli = (args: string[]) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", BIN, ...args], { encoding: "utf8", timeout: 15_000 });
  if (r.error) throw r.error; // surface ENOENT / spawn failure / timeout directly, not as null !== 0
  return r;
};

test("bin: success → exit 0 + clean JSON on stdout", () => {
  const r = runCli(["--patient", fixture("audiogram", "present_recent"), "--measure", "audiogram", "--date", EVAL]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.outcome, "COMPLIANT");
  assert.equal(parsed.subjectId, "audiogram-present_recent");
});

test("bin: usage error → exit 2 + stderr message + empty stdout", () => {
  const r = runCli(["--measure", "audiogram"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--patient .* is required/);
});
