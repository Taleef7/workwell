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

test("chooseDiffMode: no official value sets resolve → estimate (even with literal artifact present)", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([]) }, true);
  assert.equal(mode, "estimate");
});

test("chooseDiffMode: PARTIAL import (Diabetes present, HbA1c empty) → estimate (Codex P2)", async () => {
  // A partial resolve-valuesets import leaves some OIDs as empty ERROR rows; requiring only Diabetes
  // would wrongly enter a real-execution mode and fabricate missing-HbA1c divergences.
  const mode = await chooseDiffMode(
    {
      expand: (oid) =>
        Promise.resolve(oid === CMS122_HBA1C_OID ? [] : oid === CMS122_DIABETES_OID ? CODE : CODE),
    },
    true,
  );
  assert.equal(mode, "estimate");
});
