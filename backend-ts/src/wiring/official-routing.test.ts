/**
 * Roadmap §7.2 — the official-measure allowlist. Read by the exporters (PR-3) before the executor
 * that writes official evidence exists (PR-7), so the aggregate export path can never silently serve
 * status-derived populations for an official measure.
 *   node --import tsx --test src/wiring/official-routing.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOfficialRouted, officialMeasureIds } from "./official-routing.ts";
import { officialRoutingProblems } from "./executor-router.ts";

test("unset or blank means NO measure is official-routed (the demo-stack default)", () => {
  for (const env of [{}, { WORKWELL_OFFICIAL_MEASURES: "" }, { WORKWELL_OFFICIAL_MEASURES: "   " }]) {
    assert.equal(officialMeasureIds(env).size, 0);
    assert.equal(isOfficialRouted("cms122", env), false);
  }
});

test("a comma list selects exactly those measures, whitespace-tolerant", () => {
  const env = { WORKWELL_OFFICIAL_MEASURES: " cms122 , cms125 " };
  assert.deepEqual([...officialMeasureIds(env)].sort(), ["cms122", "cms125"]);
  assert.equal(isOfficialRouted("cms122", env), true);
  assert.equal(isOfficialRouted("cms125", env), true);
  assert.equal(isOfficialRouted("audiogram", env), false);
});

test('"all" is not a wildcard — every flip stays a deliberate per-measure act', () => {
  const env = { WORKWELL_OFFICIAL_MEASURES: "all" };
  assert.equal(isOfficialRouted("cms122", env), false, '"all" must not enable cms122');
  assert.equal(isOfficialRouted("all", env), true, "it is treated as a literal id, nothing more");
});

test("a non-string value is ignored rather than coerced", () => {
  assert.equal(officialMeasureIds({ WORKWELL_OFFICIAL_MEASURES: ["cms122"] }).size, 0);
  assert.equal(officialMeasureIds({ WORKWELL_OFFICIAL_MEASURES: 1 }).size, 0);
});

test("cms130 and cms165 construct without a missing-semantics routing problem", () => {
  for (const catalogId of ["cms130", "cms165"]) {
    const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: catalogId });
    assert.ok(
      !problems.some((problem) => problem.includes("no recorded numerator semantics")),
      `${catalogId} should have reviewed semantics: ${JSON.stringify(problems)}`,
    );
  }
});
