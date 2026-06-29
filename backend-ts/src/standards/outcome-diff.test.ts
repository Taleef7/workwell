import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeDiffReport, CriterionImpact } from "./outcome-diff.ts";

test("OutcomeDiffReport type exists and is importable", () => {
  // Types-only smoke: if the import fails, this test file won't parse.
  const _: OutcomeDiffReport = {
    measureId: "cms122",
    ecqmId: "CMS122v14",
    runId: null,
    asOf: null,
    totalSubjectsEvaluated: 0,
    totalDivergent: 0,
    criterionImpacts: [],
    headline: "test",
    disclaimer: "test",
  };
  assert.ok(true);
});
