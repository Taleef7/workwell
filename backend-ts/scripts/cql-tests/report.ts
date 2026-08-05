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
  "invalid-refused",
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

export interface Baseline {
  pinned: string;
  total: number;
  counts: Counts;
  perFile: Record<string, Counts>;
}

export function perFile(results: readonly CaseResult[]): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const r of results) (out[r.file] ??= tally([]))[r.outcome]++;
  return out;
}

/**
 * Compare a run against the committed baseline. Returns human-readable regressions.
 *
 * A bare "at least N passing" threshold would go green while a translator upgrade traded 30 passes for 30
 * different ones, so this compares PER FILE and treats any drop in `pass` — or any rise in `fail`,
 * `runtime-error` or `invalid-accepted` — as a regression. A rise in `pass` is reported as an improvement
 * and is NOT a failure, but it does mean the baseline needs updating in the same PR.
 */
export function regressions(current: readonly CaseResult[], baseline: Baseline): string[] {
  const out: string[] = [];
  const now = perFile(current);
  const nowTotals = tally(current);

  if (current.length < baseline.total) {
    out.push(`total cases ${current.length} < baseline ${baseline.total} — the corpus shrank`);
  }
  for (const [file, base] of Object.entries(baseline.perFile)) {
    const cur = now[file];
    if (!cur) {
      out.push(`${file}: contributed no cases (baseline had ${base.pass} passing)`);
      continue;
    }
    if (cur.pass < base.pass) out.push(`${file}: pass ${base.pass} → ${cur.pass}`);
    for (const worse of ["fail", "runtime-error", "invalid-accepted"] as const) {
      if (cur[worse] > base[worse]) out.push(`${file}: ${worse} ${base[worse]} → ${cur[worse]}`);
    }
  }
  if (nowTotals["translation-error"] > baseline.counts["translation-error"]) {
    out.push(
      `translation-error ${baseline.counts["translation-error"]} → ${nowTotals["translation-error"]} — ` +
        `the JS translator regressed, or its version moved`,
    );
  }
  return out;
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
    `  invalid-refused     ${String(c["invalid-refused"]).padStart(5)}   correctly rejected an invalid expression`,
    `  invalid-accepted    ${String(c["invalid-accepted"]).padStart(5)}   accepted CQL the corpus says is invalid`,
    `  skipped             ${String(c.skipped).padStart(5)}   capability we do not claim`,
    "",
    `  graded ${graded} of ${results.length}; pass rate ${((c.pass / graded) * 100).toFixed(2)}% of graded`,
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
      durationMs: r.durationMs,
    })),
  };
}
