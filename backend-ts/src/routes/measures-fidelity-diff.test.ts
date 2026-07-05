import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseDiffMode } from "./measures.ts";

test("chooseDiffMode: empty diabetes expansion → estimate", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([]) });
  assert.equal(mode, "estimate");
});
test("chooseDiffMode: non-empty diabetes expansion → execution", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([{ code: "44054006", system: "http://snomed.info/sct" }]) });
  assert.equal(mode, "execution");
});
