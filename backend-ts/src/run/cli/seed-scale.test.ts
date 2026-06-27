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
