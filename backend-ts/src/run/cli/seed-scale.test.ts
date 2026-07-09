/**
 * seed:scale CLI arg parsing (#185 E13 PR-2).
 *   node --import tsx --test src/run/cli/seed-scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveTrimEvidence, AUTO_TRIM_THRESHOLD, SeedCliUsageError } from "./seed-scale.ts";

test("parseArgs reads --subjects/--as-of and rejects bad input", () => {
  assert.deepEqual(parseArgs(["--subjects", "120000", "--as-of", "2026-06-26"]), { subjects: 120000, asOf: "2026-06-26" });
  assert.throws(() => parseArgs(["--subjects", "0"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--subjects", "x"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--as-of", "nope"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--bogus"]), SeedCliUsageError);
});

test("defaults: no args parse to empty (caller applies the 120k default)", () => {
  assert.deepEqual(parseArgs([]), {});
});

test("parseArgs reads --mode and rejects bad values (default resolves to evaluate)", () => {
  assert.equal(parseArgs(["--mode", "evaluate"]).mode, "evaluate");
  assert.equal(parseArgs(["--mode", "fabricated"]).mode, "fabricated");
  assert.equal(parseArgs([]).mode ?? "evaluate", "evaluate");
  assert.throws(() => parseArgs(["--mode", "bogus"]), /--mode/);
  assert.throws(() => parseArgs(["--mode", "bogus"]), SeedCliUsageError);
});

test("parseArgs reads --trim-evidence (boolean, default falsy)", () => {
  assert.equal(parseArgs(["--trim-evidence"]).trimEvidence, true);
  assert.ok(!parseArgs([]).trimEvidence);
});

test("new flags compose with --subjects/--as-of", () => {
  assert.deepEqual(parseArgs(["--subjects", "5000", "--mode", "evaluate", "--trim-evidence"]), {
    subjects: 5000,
    mode: "evaluate",
    trimEvidence: true,
  });
});

test("parseArgs reads --workers as a non-negative integer and rejects bad input (#256)", () => {
  assert.equal(parseArgs(["--workers", "4"]).workers, 4);
  assert.equal(parseArgs(["--workers", "1"]).workers, 1); // sequential escape hatch
  assert.equal(parseArgs(["--workers", "0"]).workers, 0); // also sequential
  assert.equal(parseArgs([]).workers, undefined); // default resolved by the caller (4, clamped by cores)
  assert.throws(() => parseArgs(["--workers", "-1"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--workers", "2.5"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--workers", "x"]), SeedCliUsageError);
});

test("--workers composes with the other evaluate flags (#256)", () => {
  assert.deepEqual(parseArgs(["--subjects", "120000", "--mode", "evaluate", "--trim-evidence", "--workers", "8"]), {
    subjects: 120000,
    mode: "evaluate",
    trimEvidence: true,
    workers: 8,
  });
});

test("parseArgs reads --full-evidence and rejects it combined with --trim-evidence (#257)", () => {
  assert.equal(parseArgs(["--full-evidence"]).fullEvidence, true);
  assert.ok(!parseArgs([]).fullEvidence);
  assert.throws(() => parseArgs(["--trim-evidence", "--full-evidence"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--full-evidence", "--trim-evidence"]), /mutually exclusive/);
});

test("resolveTrimEvidence: auto-trim engages STRICTLY above the 20000 threshold (#257)", () => {
  assert.equal(AUTO_TRIM_THRESHOLD, 20_000);
  // At the threshold exactly → NO auto-trim; one above → auto-trim.
  assert.deepEqual(resolveTrimEvidence({ subjects: 20_000 }), { trim: false, auto: false });
  assert.deepEqual(resolveTrimEvidence({ subjects: 20_001 }), { trim: true, auto: true });
  assert.deepEqual(resolveTrimEvidence({ subjects: 120_000 }), { trim: true, auto: true });
  assert.deepEqual(resolveTrimEvidence({ subjects: 500 }), { trim: false, auto: false });
});

test("resolveTrimEvidence: --full-evidence overrides the auto-trim; --trim-evidence forces trim at any N (#257)", () => {
  // Explicit full-evidence wins even far above the threshold (the override the notice points at).
  assert.deepEqual(resolveTrimEvidence({ subjects: 120_000, fullEvidence: true }), { trim: false, auto: false });
  // Explicit trim below the threshold is honored (not auto — no notice).
  assert.deepEqual(resolveTrimEvidence({ subjects: 500, trimEvidence: true }), { trim: true, auto: false });
  // Explicit trim above the threshold is explicit, not auto.
  assert.deepEqual(resolveTrimEvidence({ subjects: 120_000, trimEvidence: true }), { trim: true, auto: false });
});
