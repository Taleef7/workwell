/**
 * #263 Phase 2a — logic_version golden tests. Guarantees (design §3):
 *   - a semantic ELM change invalidates; ELM key-reorder does not;
 *   - a value-set expansion-hash change invalidates (the VSAC-reimport case everyone forgets);
 *   - expansion-hash *order* never matters.
 *   node --import tsx --test src/run/incremental/logic-version.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLogicVersion } from "./logic-version.ts";
import { ELM_LIBRARIES } from "../../engine/cql/elm/index.ts";

const audiogramElm = ELM_LIBRARIES["AnnualAudiogramCompleted-1.0.0"];
const tbElm = ELM_LIBRARIES["TbSurveillance-1.3.0"];

test("output is the house sha256:<hex> format", async () => {
  assert.match(await computeLogicVersion(audiogramElm), /^sha256:[0-9a-f]{64}$/);
});

test("same ELM + no value sets is stable", async () => {
  assert.equal(await computeLogicVersion(audiogramElm), await computeLogicVersion(audiogramElm));
});

test("a different measure's ELM produces a different logic_version", async () => {
  assert.notEqual(await computeLogicVersion(audiogramElm), await computeLogicVersion(tbElm));
});

test("ELM object-key reordering does NOT invalidate (compiler-artifact order)", async () => {
  const reordered = JSON.parse(JSON.stringify(audiogramElm), (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).reverse())
      : v,
  );
  assert.equal(await computeLogicVersion(audiogramElm), await computeLogicVersion(reordered));
});

test("a value-set expansion-hash change invalidates (VSAC re-import)", async () => {
  const before = await computeLogicVersion(audiogramElm, ["sha256:aaa"]);
  const after = await computeLogicVersion(audiogramElm, ["sha256:bbb"]);
  assert.notEqual(before, after);
});

test("expansion-hash ORDER does not matter", async () => {
  const a = await computeLogicVersion(audiogramElm, ["sha256:aaa", "sha256:bbb"]);
  const b = await computeLogicVersion(audiogramElm, ["sha256:bbb", "sha256:aaa"]);
  assert.equal(a, b);
});

test("adding a value set invalidates (empty vs one)", async () => {
  assert.notEqual(await computeLogicVersion(audiogramElm), await computeLogicVersion(audiogramElm, ["sha256:aaa"]));
});
