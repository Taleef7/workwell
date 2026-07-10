/**
 * seed:scale CLI arg parsing (#185 E13 PR-2).
 *   node --import tsx --test src/run/cli/seed-scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, SeedCliUsageError } from "./seed-scale.ts";

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
