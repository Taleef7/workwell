import { strict as assert } from "node:assert";
import { test } from "node:test";

import { targetForIndex } from "./scale-generator.ts";

test("targetForIndex: first round(rate*n) are COMPLIANT, remainder cycles", () => {
  const n = 10;
  const rate = 0.5;
  const got = Array.from({ length: n }, (_, i) => targetForIndex(i, n, rate));
  assert.deepEqual(got, [
    "COMPLIANT",
    "COMPLIANT",
    "COMPLIANT",
    "COMPLIANT",
    "COMPLIANT",
    "OVERDUE",
    "DUE_SOON",
    "MISSING_DATA",
    "EXCLUDED",
    "OVERDUE",
  ]);
});
