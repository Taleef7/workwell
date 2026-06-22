import { test } from "node:test";
import assert from "node:assert/strict";
import { PANELS, DEFAULT_PANEL, isPanelId } from "./panels.ts";

test("panels expose the three column sets and a default", () => {
  assert.deepEqual(Object.keys(PANELS).sort(), ["immunizations", "osha", "wellness"]);
  assert.ok(PANELS.immunizations.includes("mmr"));
  assert.ok(PANELS.immunizations.includes("hepatitis_b_vaccination_series"));
  assert.equal(DEFAULT_PANEL, "immunizations");
});

test("isPanelId narrows known panel ids", () => {
  assert.equal(isPanelId("osha"), true);
  assert.equal(isPanelId("nope"), false);
});
