import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";

test("existing recurring measures default to complianceClass RECURRING", () => {
  assert.equal(MEASURE_BINDINGS["audiogram"]!.complianceClass, "RECURRING");
  assert.equal(MEASURE_BINDINGS["adult_immunization"]!.complianceClass, "RECURRING");
});

test("a permanent vaccine measure carries complianceClass PERMANENT + series.requiredDoses", () => {
  const mmr = MEASURE_BINDINGS["mmr"];
  assert.ok(mmr, "mmr binding must exist after gen-measure-bindings");
  assert.equal(mmr.complianceClass, "PERMANENT");
  assert.equal(mmr.series?.requiredDoses, 2);
});
