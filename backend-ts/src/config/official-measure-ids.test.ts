import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VENDORED_OFFICIAL_MEASURE_IDS, isVendoredOfficialMeasure } from "./official-measure-ids.ts";

const dir = fileURLToPath(new URL("../../measures/official/", import.meta.url));

test("the vendored id list is exactly the directory listing under measures/official (sorted)", () => {
  const expected = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual([...VENDORED_OFFICIAL_MEASURE_IDS], expected);
  assert.ok(expected.includes("cms2") && expected.includes("cms130") && expected.includes("cms165"));
});

test("isVendoredOfficialMeasure is a plain membership test, immune to inherited keys", () => {
  assert.equal(isVendoredOfficialMeasure("cms122"), true);
  assert.equal(isVendoredOfficialMeasure("constructor"), false);
  assert.equal(isVendoredOfficialMeasure("cms137"), false);
});
