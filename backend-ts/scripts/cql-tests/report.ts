/**
 * Summarizing and grading the V7 conformance run.
 *
 * ## The non-degeneracy problem this file exists to solve
 *
 * A conformance harness is the textbook vacuous guard: parse nothing, run nothing, report no failures,
 * look green. This codebase has caught that shape four times (#350, #354, #363, #365), and here it would
 * be worse than a silent guard — it would produce a NUMBER that gets published.
 *
 * So the run asserts its own reach before any figure is reported: the expected case count, every file
 * contributing, and every case landing in exactly one bucket with the buckets summing to the total.
 * A pass RATE over an unstated denominator is exactly the artifact we must not ship.
 */
import type { CaseResult, Outcome } from "./run.ts";

/**
 * The corpus at the pinned commit (727219f, 2026-08-03). A parse that returns a different number means
 * upstream moved or our reader broke — either way the run must say so rather than grade a subset.
 * Update deliberately, in the PR that moves the pin.
 */
export const EXPECTED_CASES = 1835;
export const EXPECTED_FILES = 16;

export const OUTCOMES: readonly Outcome[] = [
  "pass",
  "fail",
  "translation-error",
  "runtime-error",
  "invalid-refused-at-translation",
  "invalid-refused-at-runtime",
  "invalid-accepted",
  "skipped",
];

export type Counts = Record<Outcome, number>;

export function tally(results: readonly CaseResult[]): Counts {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Counts;
  for (const r of results) counts[r.outcome]++;
  return counts;
}

export class DegenerateRunError extends Error {}

/**
 * Refuse to report a run that did not reach what it claims to have measured. Only applies to a FULL run —
 * `--file`/`--group`/`--test` filters legitimately reduce the set, so the caller passes `filtered: true`
 * and gets the structural checks without the corpus-size ones.
 */
export function assertNonDegenerate(
  results: readonly CaseResult[],
  files: readonly string[],
  opts: { filtered: boolean },
): void {
  const counts = tally(results);
  const summed = OUTCOMES.reduce((n, o) => n + counts[o], 0);

  // Structural — true of any run, filtered or not.
  if (summed !== results.length) {
    throw new DegenerateRunError(
      `buckets sum to ${summed} but ${results.length} cases ran — a case is in an unclassified state`,
    );
  }
  if (results.length === 0) throw new DegenerateRunError("zero cases ran");

  if (opts.filtered) return;

  if (files.length !== EXPECTED_FILES) {
    throw new DegenerateRunError(`read ${files.length} test files, expected ${EXPECTED_FILES}`);
  }
  if (results.length !== EXPECTED_CASES) {
    throw new DegenerateRunError(
      `ran ${results.length} cases, expected ${EXPECTED_CASES} at the pinned commit — ` +
        `upstream moved, or the reader is dropping cases`,
    );
  }
  const seen = new Set(results.map((r) => r.file));
  const silent = files.filter((f) => !seen.has(f));
  if (silent.length > 0) {
    throw new DegenerateRunError(`these files contributed no cases: ${silent.join(", ")}`);
  }
}

/** Stable identity of one case, so the baseline compares like with like across runs. */
export const caseKey = (r: Pick<CaseResult, "file" | "group" | "name">): string =>
  `${r.file}/${r.group}/${r.name}`;

export interface Baseline {
  pinned: string;
  total: number;
  counts: Counts;
  perFile: Record<string, Counts>;
  /**
   * Every case that is NOT passing, keyed by `file/group/name`.
   *
   * **Per CASE, not per file** (review, #398). Per-file tallies cannot see the regression shape this gate
   * exists for: inside one XML file, a previously passing case can go `fail` while a previously failing one
   * goes `pass`, leaving both counts identical and CI green — the same "trade 30 passes for 30 different
   * ones" hazard that ruled out a bare threshold, one level down. The first cut had exactly that hole.
   *
   * Only the non-passing cases are stored, and that is not a size optimization dressed up as design: a case
   * ABSENT from this map was passing, so "used to pass, now does not" is decidable for every one of the
   * 1,835 without listing them. 213 entries instead of 1,835, and no information lost.
   */
  notPassing: Record<string, Outcome>;
  /**
   * How many cases were compared in JS rather than by CQL's own `~`.
   *
   * Tracked because a first draft of the evidence claimed this was ZERO — a claim only possible because
   * `runnerJson` was not serializing the field, so both the author and a reviewer read `0` off a key that
   * was never written (review, #398). It is 16. A number that describes how much of the result rests on
   * the weaker grading path must be recorded, not inferred from an absent field.
   */
  gradedInJs: number;
}

export function notPassing(results: readonly CaseResult[]): Record<string, Outcome> {
  const out: Record<string, Outcome> = {};
  for (const r of results) if (r.outcome !== "pass") out[caseKey(r)] = r.outcome;
  return out;
}

export function perFile(results: readonly CaseResult[]): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const r of results) (out[r.file] ??= tally([]))[r.outcome]++;
  return out;
}

/**
 * Compare a run against the committed baseline, PER CASE. Returns human-readable regressions.
 *
 * A regression is any individual case that used to pass and no longer does. Reported alongside, but NOT
 * failing: a case that changed from one non-passing outcome to another (e.g. `fail` → `translation-error`)
 * — the evidence document describes those buckets, so drift between them should be visible even though it
 * is not a loss.
 *
 * A case that starts passing is an improvement, not a failure — but the baseline must be regenerated in
 * the same PR so the gate holds the new floor.
 */
export function regressions(current: readonly CaseResult[], baseline: Baseline): string[] {
  const out: string[] = [];
  if (current.length < baseline.total) {
    out.push(`total cases ${current.length} < baseline ${baseline.total} — the corpus shrank`);
  }
  const jsNow = current.filter((r) => r.gradedInJs).length;
  if (baseline.gradedInJs !== undefined && jsNow > baseline.gradedInJs) {
    out.push(`gradedInJs ${baseline.gradedInJs} → ${jsNow} — more of the result rests on the weaker path`);
  }

  const base = baseline.notPassing ?? {};
  const seen = new Set<string>();

  for (const r of current) {
    const key = caseKey(r);
    seen.add(key);
    const was = base[key];
    if (r.outcome === "pass") continue;
    if (was === undefined) {
      out.push(`${key}: pass → ${r.outcome}`);
    } else if (was !== r.outcome) {
      // Not a loss, but the evidence doc enumerates these buckets, so a silent shuffle between them
      // would let the committed findings drift out of date while CI stayed green.
      out.push(`${key}: ${was} → ${r.outcome} (outcome changed)`);
    }
  }

  // A case in the baseline that did not run at all is a hole in the corpus, not an improvement.
  for (const key of Object.keys(base)) {
    if (!seen.has(key)) out.push(`${key}: did not run (baseline had ${base[key]})`);
  }
  return out;
}

/** Cases that started passing since the baseline — reported, never a failure. */
export function improvements(current: readonly CaseResult[], baseline: Baseline): string[] {
  const base = baseline.notPassing ?? {};
  return current
    .filter((r) => r.outcome === "pass" && base[caseKey(r)] !== undefined)
    .map((r) => `${caseKey(r)}: ${base[caseKey(r)]} → pass`);
}

export function summary(results: readonly CaseResult[], files: readonly string[]): string {
  const c = tally(results);
  const graded = results.length - c.skipped;
  const lines = [
    `cql-tests conformance — ${results.length} cases across ${files.length} files`,
    "",
    `  pass                ${String(c.pass).padStart(5)}`,
    `  fail                ${String(c.fail).padStart(5)}   engine computed the wrong value`,
    `  translation-error   ${String(c["translation-error"]).padStart(5)}   our JS translator rejected valid CQL`,
    `  runtime-error       ${String(c["runtime-error"]).padStart(5)}`,
    `  invalid-refused     ${String(c["invalid-refused-at-translation"] + c["invalid-refused-at-runtime"]).padStart(5)}   rejected an invalid expression (${c["invalid-refused-at-translation"]} at translation, ${c["invalid-refused-at-runtime"]} at runtime)`,
    `  invalid-accepted    ${String(c["invalid-accepted"]).padStart(5)}   translated AND evaluated CQL the corpus says is invalid`,
    `  skipped             ${String(c.skipped).padStart(5)}   capability we do not claim`,
    "",
    `  graded ${graded} of ${results.length}; pass rate ${((c.pass / graded) * 100).toFixed(2)}% of graded`,
    `  of those, ${results.filter((r) => r.gradedInJs).length} compared in JS rather than by CQL \`~\` ` +
      `(the weaker path — see ADR-060)`,
  ];
  return lines.join("\n");
}

/**
 * The `cql-tests-runner` JSON shape, so a published comparison is a format match rather than a
 * translation, and phase 2 (driving us through a `$cql` operation) emits the same thing.
 */
export function runnerJson(results: readonly CaseResult[], meta: { pinned: string; translator: string; engine: string }) {
  return {
    ...meta,
    testsRun: results.length,
    counts: tally(results),
    results: results.map((r) => ({
      testsName: r.file.replace(/\.xml$/, ""),
      groupName: r.group,
      testName: r.name,
      testStatus: r.outcome,
      expression: r.expression,
      ...(r.expected !== undefined ? { expected: r.expected } : {}),
      ...(r.actual !== undefined ? { actual: r.actual } : {}),
      ...(r.diagnostic !== undefined ? { error: r.diagnostic } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.skippedFor !== undefined ? { skippedFor: r.skippedFor } : {}),
      ...(r.gradedInJs ? { gradedInJs: true } : {}),
      durationMs: r.durationMs,
    })),
  };
}
