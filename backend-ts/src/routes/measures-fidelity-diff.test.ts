import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseDiffMode } from "./measures.ts";
import { CMS122_DIABETES_OID, CMS122_HBA1C_OID } from "../standards/cms122-official.ts";

const CODE = [{ code: "44054006", system: "http://snomed.info/sct" }];

// Three-tier ladder (#258): literal → subset → estimate. `chooseDiffMode(resolver, literalAvailable)`.

test("chooseDiffMode: value sets resolve + literal artifact present → literal", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve(CODE) }, true);
  assert.equal(mode, "literal");
});

test("chooseDiffMode: value sets resolve + literal artifact ABSENT → subset", async () => {
  // The vendored official bundle isn't available (or hasn't been loaded) → fall back to the ADR-024 subset.
  const mode = await chooseDiffMode({ expand: () => Promise.resolve(CODE) }, false);
  assert.equal(mode, "subset");
});

test("chooseDiffMode: value sets resolve, literalAvailable defaulted → subset (never claims literal blindly)", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve(CODE) });
  assert.equal(mode, "subset");
});

test("chooseDiffMode: no VSAC value sets → STILL literal when the artifact is available (PR-8d)", async () => {
  // Changed deliberately. Since ADR-036 the literal tier takes its terminology from the artifact's own
  // vendored sidecar and never reads `value_sets`, so this probe cannot inform it — yet gating on it
  // declined a fully working literal diff on any stack that never ran `pnpm resolve-valuesets` (a fresh
  // clone, local dev, any deployment without the import), silently reporting `mode: "estimate"`.
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([]) }, true);
  assert.equal(mode, "literal");
});

test("chooseDiffMode: no VSAC value sets and no literal artifact → estimate", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([]) }, false);
  assert.equal(mode, "estimate");
});

test("chooseDiffMode: PARTIAL import (Diabetes present, HbA1c empty) → estimate (Codex P2)", async () => {
  // A partial resolve-valuesets import leaves some OIDs as empty ERROR rows; requiring only Diabetes
  // would wrongly enter the SUBSET tier and fabricate missing-HbA1c divergences. `literalAvailable`
  // is false here — with it true the answer is now literal, which does not read these rows at all.
  const mode = await chooseDiffMode(
    {
      expand: (oid) =>
        Promise.resolve(oid === CMS122_HBA1C_OID ? [] : oid === CMS122_DIABETES_OID ? CODE : CODE),
    },
    false,
  );
  assert.equal(mode, "estimate");
});

test("the SUBSET tier is unreachable for any measure but cms122 (route containment)", async () => {
  // The invariant the diff route's two guards exist for: `computeExecutionDiff` executes a
  // hand-authored official-subset CQL that exists for cms122 alone, so reporting it under another
  // measure's name would be cms122's criteria wearing cms125's label. Asserted here rather than by
  // inspection, because the reasoning spans two functions and an `if`.
  //
  // `chooseDiffMode` returns "subset" only when `literalAvailable` is false — and the route's outer
  // guard `(diffId === "cms122" || literalAvailable)` then excludes every other measure. So for a
  // non-cms122 measure the two conditions cannot both hold.
  for (const literalAvailable of [true, false]) {
    const mode = await chooseDiffMode({ expand: () => Promise.resolve(CODE) }, literalAvailable);
    const outerGuardAdmits = (diffId: string) => diffId === "cms122" || literalAvailable;
    if (mode === "subset") {
      assert.equal(outerGuardAdmits("cms125"), false, "a non-cms122 measure reached the subset tier");
    }
  }
});
