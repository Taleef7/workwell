/**
 * seed:quality-history CLI arg parsing (mirrors seed-trend-history's test). Pure parse — no DB.
 *   node --import tsx --test src/run/cli/seed-quality-history.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, SeedCliUsageError } from "./seed-quality-history.ts";

test("defaults are empty (lib fills months=12 / current month)", () => {
  assert.deepEqual(parseArgs([]), {});
});

test("parses --months and --as-of", () => {
  assert.deepEqual(parseArgs(["--months", "6", "--as-of", "2026-06"]), { months: 6, asOf: "2026-06" });
});

test("rejects bad flags", () => {
  assert.throws(() => parseArgs(["--months", "0"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--months", "x"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--as-of", "2026-6"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--as-of", "2026-06-01"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--as-of", "2026-13"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--as-of", "2026-00"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--nope"]), SeedCliUsageError);
});
