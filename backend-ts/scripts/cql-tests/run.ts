/**
 * The V7 conformance runner: `cqframework/cql-tests` through OUR translator and OUR engine.
 *
 * ## What this measures that nothing else does
 *
 * `cql-execution` 3.3.x — our exact runtime — has published results at `cql-tests-runner.quality.hl7.org`
 * (1,533 pass / 81 fail / 113 skip / 4 error). **That run used the JAVA translator.** We translate with
 * `@cqframework/cql` 4.0.0-beta.1, the JS translator, and the delta between those two has never been
 * published. This runner measures it.
 *
 * That is why `translation-error` is its own outcome and is NEVER folded into `fail`. Folding them would
 * report a translator gap as an engine defect — attributing the finding to `cql-execution`, whose own
 * posted results say otherwise. **The difference between those two columns IS the deliverable.**
 *
 * ## How a case is graded, without parsing CQL literals in JavaScript
 *
 * Each case becomes a three-define library and CQL performs its own comparison:
 *
 *   define Actual: <expression>
 *   define Expected: <output>
 *   define Passed: Actual ~ Expected
 *
 * `~` is CQL equivalence, which is null-safe (`null ~ null` is true) and handles quantities, intervals,
 * lists and tuples by the language's own rules. Writing a literal parser in TypeScript would mean
 * re-implementing a chunk of CQL semantics in order to test CQL semantics — the comparison would then
 * share a defect with the thing under test.
 *
 * Execution is UNFILTERED — no patient, no data model, no terminology. Every case in this corpus is
 * data-free by construction.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { evaluateExpressions } from "@work-well/measure-engine";
import { compileCql, type CqlDiagnostic } from "../../src/measure/cql-translator.ts";
import { parseTestFile, ParseError, type CqlTestCase } from "./parse-tests.ts";
import { skipDecision } from "./capabilities.ts";
import { validateUnit } from "../../src/measure/ucum.ts";

export type Outcome =
  | "pass"
  | "fail"
  | "translation-error"
  | "runtime-error"
  | "skipped"
  /** An `invalid` case the TRANSLATOR refused. */
  | "invalid-refused-at-translation"
  /** An `invalid` case that translated but threw when executed — still a refusal upstream. */
  | "invalid-refused-at-runtime"
  /** An `invalid` case that translated AND evaluated. The corpus says it should have failed. */
  | "invalid-accepted";

/**
 * How `cqframework/cql-tests-runner` grades an `invalid` case — copied here because getting it wrong
 * produced a materially overstated finding (review, #398).
 *
 * `src/services/test-runner.ts`:
 * ```ts
 * const invalid = result.invalid;
 * if (invalid === 'true' || invalid === 'semantic') {
 *     result.testStatus = response.status === 200 ? 'fail' : 'pass';
 * }
 * ```
 *
 * Two things follow that our first cut got wrong:
 *
 * 1. **A non-200 is ANY failure — translation or evaluation.** We graded purely on whether the
 *    expression TRANSLATED, so a case that translated and then threw at runtime was reported as
 *    `invalid-accepted` when upstream counts it a pass. Measured: **5 of our 36** do exactly that.
 * 2. **`invalid="syntax"` does not take this branch at all** — it falls through to normal grading
 *    upstream. There are 2 such cases, and one of them (`Ceiling(2147483648)`) was the headline example
 *    of a published finding.
 *
 * So `invalid` cases are now EXECUTED when they translate, and the refusal bucket is split by where the
 * refusal happened. `syntax` is tracked separately rather than folded in, because we cannot reproduce
 * upstream's else-branch grading (those cases carry no `<output>` to compare against).
 */
const REFUSAL_IS_ANY_FAILURE = new Set(["true", "semantic"]);

export interface CaseResult {
  file: string;
  group: string;
  name: string;
  outcome: Outcome;
  expression: string;
  expected?: string;
  /** Rendered actual value, when the case ran. */
  actual?: string;
  /** First translator diagnostic, for the translation-error bucket — this is the reportable detail. */
  diagnostic?: string;
  /** Capability that caused a skip, with the reason we do not claim it. */
  skippedFor?: { capability: string; reason: string };
  /**
   * True when CQL's own `~` could not be compiled for this case and the two values were compared in JS
   * instead. Surfaced in the report because it is a weaker grading path — a reader should be able to see
   * exactly which results rest on it.
   */
  gradedInJs?: boolean;
  error?: string;
  durationMs: number;
}

/**
 * A test case's CQL library.
 *
 * `mode: "compare"` adds `define Passed: Actual ~ Expected` and lets CQL grade itself. `mode: "values"`
 * omits it — see `runCase` for when that is needed and why it is not the default.
 */
export function buildLibrary(c: CqlTestCase, mode: "compare" | "values" = "compare"): string {
  // The library name must be a valid identifier; case names are already identifier-shaped but the corpus
  // is upstream data, so it is sanitized rather than trusted.
  const id = `Test${c.name.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const head = `library ${id} version '1.0.0'\n`;
  if (c.invalid !== undefined) return `${head}define Actual: ${c.expression}\n`;
  const body = `define Actual: ${c.expression}\ndefine Expected: ${c.output}\n`;
  return mode === "values" ? `${head}${body}` : `${head}${body}define Passed: Actual ~ Expected\n`;
}

/**
 * Does this diagnostic come from OUR `Actual ~ Expected` line rather than from the case's own expression?
 *
 * Measured on the first full run: 16 cases failed to translate solely because the comparison would not
 * type-check — `Equivalent(System.Integer, interval<System.Integer>)` when a case's expected value is a
 * different type from its actual, and `Equivalent(System.Any, System.Any)` reported as ambiguous. Both are
 * artefacts of the grading mechanism. Reporting them as `translation-error` would blame the JS translator
 * for a limitation of the harness — the same misattribution the UCUM service caused at 10× the scale.
 */
function isComparisonArtefact(diagnostic: string | undefined): boolean {
  return diagnostic !== undefined && /\bEquivalent\b/.test(diagnostic);
}

/**
 * Compare two evaluated CQL values in JS — used ONLY on the fallback path, where CQL's own `~` could not
 * be compiled. Deliberately conservative: it is not a re-implementation of CQL equivalence, and it is not
 * used for the 1,800+ cases that grade themselves.
 */
function valuesEquivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  const eq = (a as { equals?: (o: unknown) => boolean }).equals;
  if (typeof eq === "function") {
    try {
      return eq.call(a, b) === true;
    } catch {
      /* fall through to the string comparison */
    }
  }
  return render(a) === render(b);
}

const firstDiagnostic = (ds: CqlDiagnostic[]): string | undefined => {
  const err = ds.find((d) => /error/i.test(d.severity)) ?? ds[0];
  return err ? `${err.severity}: ${err.message}` : undefined;
};

/** Render a CQL value for the report. Never throws — a value that will not stringify is still a result. */
function render(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") {
    try {
      const s = (v as { toString?: () => string }).toString?.();
      if (typeof s === "string" && s !== "[object Object]") return s;
      return JSON.stringify(v) ?? String(v);
    } catch {
      return "(unrenderable)";
    }
  }
  return String(v);
}

export async function runCase(c: CqlTestCase): Promise<CaseResult> {
  const started = Date.now();
  const base = { file: c.file, group: c.group, name: c.name, expression: c.expression };
  const done = (r: Omit<CaseResult, keyof typeof base | "durationMs">): CaseResult => ({
    ...base,
    ...r,
    durationMs: Date.now() - started,
  });

  const skip = skipDecision(c.capabilities);
  if (skip.skip) {
    return done({
      outcome: "skipped",
      skippedFor: { capability: skip.capability!, reason: skip.reason! },
    });
  }

  // The UCUM validator is what lets a quantity literal translate at all — without it the translator's
  // default service throws and every unit-bearing case reads as a translator gap (155 of them, measured).
  const compile = (mode: "compare" | "values") => compileCql(buildLibrary(c, mode), { validateUnit });

  let compiled;
  try {
    compiled = compile("compare");
  } catch (err) {
    // The translator THREW rather than returning diagnostics. Distinct from a clean rejection, and worth
    // seeing: it means our wrapper handed it something it could not even fail gracefully on.
    return done({ outcome: "translation-error", error: String(err).slice(0, 300) });
  }

  if (c.invalid !== undefined) {
    if (!compiled.ok) return done({ outcome: "invalid-refused-at-translation" });
    // It translated. Upstream grades on whether the whole request failed, so EXECUTE it: a case that
    // translates and then throws is a refusal too, and calling it "accepted" overstates the finding.
    try {
      await evaluateExpressions(compiled.elm);
      return done({ outcome: "invalid-accepted" });
    } catch (err) {
      return done({ outcome: "invalid-refused-at-runtime", error: String(err).slice(0, 300) });
    }
  }

  let gradedInJs = false;
  if (!compiled.ok) {
    const diagnostic = firstDiagnostic(compiled.diagnostics);
    if (!isComparisonArtefact(diagnostic)) {
      return done({ outcome: "translation-error", diagnostic });
    }
    // Our comparison line is what failed, not the case. Retry without it and grade the two values.
    const values = compile("values");
    if (!values.ok) {
      return done({ outcome: "translation-error", diagnostic: firstDiagnostic(values.diagnostics) });
    }
    compiled = values;
    gradedInJs = true;
  }

  try {
    const defines = await evaluateExpressions(compiled.elm);

    // The defines we asked for must BE there. If `Passed` is absent — a translator that emits
    // `context: "Patient"`, an `evaluateExpressions` regression, an ELM shape change — then
    // `defines["Passed"] === true` is false and the case reads as `fail`, which the report labels
    // "engine computed the wrong value". That is the exact misattribution ADR-060 decision 1 exists to
    // prevent, one layer down, and it would fire EN MASSE while still producing a plausible report
    // (review, #398).
    const required = gradedInJs ? ["Actual", "Expected"] : ["Actual", "Passed"];
    const absent = required.filter((d) => !(d in defines));
    if (absent.length > 0) {
      return done({
        outcome: "runtime-error",
        expected: c.output,
        error: `harness: define(s) ${absent.join(", ")} absent from the evaluation result — this is a HARNESS fault, not an engine result`,
      });
    }

    const passed = gradedInJs
      ? valuesEquivalent(defines["Actual"], defines["Expected"])
      : defines["Passed"] === true;
    return done({
      outcome: passed ? "pass" : "fail",
      expected: c.output,
      actual: render(defines["Actual"]),
      ...(gradedInJs ? { gradedInJs: true } : {}),
    });
  } catch (err) {
    return done({ outcome: "runtime-error", expected: c.output, error: String(err).slice(0, 300) });
  }
}

export interface Corpus {
  cases: CqlTestCase[];
  files: string[];
}

/** Read every `tests/cql/*.xml` under `root`. Refuses an empty or unreadable corpus. */
export function loadCorpus(root: string): Corpus {
  const dir = path.join(root, "tests", "cql");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".xml")).sort();
  } catch (err) {
    throw new ParseError(`cannot read ${dir} — run 'pnpm cql-tests:fetch' first (${String(err)})`);
  }
  if (names.length === 0) throw new ParseError(`${dir} contains no .xml files`);

  const cases: CqlTestCase[] = [];
  for (const name of names) {
    const parsed = parseTestFile(name, readFileSync(path.join(dir, name), "utf8"));
    cases.push(...parsed);
  }
  return { cases, files: names };
}

export interface RunFilter {
  file?: string;
  group?: string;
  test?: string;
}

export async function runCorpus(
  corpus: Corpus,
  filter: RunFilter = {},
  onProgress?: (done: number, total: number) => void,
): Promise<CaseResult[]> {
  const selected = corpus.cases.filter(
    (c) =>
      (!filter.file || c.file.toLowerCase().includes(filter.file.toLowerCase())) &&
      (!filter.group || c.group === filter.group) &&
      (!filter.test || c.name === filter.test),
  );
  const results: CaseResult[] = [];
  for (const c of selected) {
    results.push(await runCase(c));
    onProgress?.(results.length, selected.length);
  }
  return results;
}
