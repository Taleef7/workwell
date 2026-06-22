import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";

test("existing recurring measures default to complianceClass RECURRING", () => {
  assert.equal(MEASURE_BINDINGS["audiogram"]!.complianceClass, "RECURRING");
  assert.equal(MEASURE_BINDINGS["adult_immunization"]!.complianceClass, "RECURRING");
});
