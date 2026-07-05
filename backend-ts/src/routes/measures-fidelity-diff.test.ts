import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseDiffMode } from "./measures.ts";
import { CMS122_DIABETES_OID, CMS122_HBA1C_OID } from "../standards/cms122-official.ts";

const CODE = [{ code: "44054006", system: "http://snomed.info/sct" }];

test("chooseDiffMode: all official value sets non-empty → execution", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve(CODE) });
  assert.equal(mode, "execution");
});

test("chooseDiffMode: no official value sets resolve → estimate", async () => {
  const mode = await chooseDiffMode({ expand: () => Promise.resolve([]) });
  assert.equal(mode, "estimate");
});

test("chooseDiffMode: PARTIAL import (Diabetes present, HbA1c empty) → estimate (Codex P2)", async () => {
  // A partial resolve-valuesets import leaves some OIDs as empty ERROR rows; requiring only Diabetes
  // would wrongly enter execution mode and fabricate missing-HbA1c divergences.
  const mode = await chooseDiffMode({
    expand: (oid) =>
      Promise.resolve(oid === CMS122_HBA1C_OID ? [] : oid === CMS122_DIABETES_OID ? CODE : CODE),
  });
  assert.equal(mode, "estimate");
});
