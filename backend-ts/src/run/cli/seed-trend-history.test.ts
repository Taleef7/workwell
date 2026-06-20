/**
 * Arg-parsing tests for the seed:trend-history CLI (synthetic trend history feature).
 * The heavy path (build stores → backfill) is covered by backfill-trend-history.test.ts; this
 * just pins the CLI's flag handling so a bad invocation fails cleanly (exit 2, not a stack trace).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, SeedCliUsageError } from "./seed-trend-history.ts";

test("parseArgs defaults to no overrides", () => {
  assert.deepEqual(parseArgs([]), {});
});

test("parseArgs reads --weeks and --as-of", () => {
  assert.deepEqual(parseArgs(["--weeks", "8", "--as-of", "2026-06-20"]), { weeks: 8, asOf: "2026-06-20" });
});

test("parseArgs rejects a non-positive --weeks", () => {
  assert.throws(() => parseArgs(["--weeks", "0"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--weeks", "nope"]), SeedCliUsageError);
});

test("parseArgs rejects a malformed --as-of", () => {
  assert.throws(() => parseArgs(["--as-of", "06/20/2026"]), SeedCliUsageError);
});

test("parseArgs rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["--bogus"]), SeedCliUsageError);
});
