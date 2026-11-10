/**
 * Item 13: a Studio measure's name and policy reference state no CMS identity.
 *   node --import tsx --test src/measure/measure-naming.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedCmsIdentity, cmsIdentityRefusal, sameMeasureName } from "./measure-naming.ts";

test("an eCQM id or a MIPS quality id is a CMS identity, in any case and form", () => {
  for (const [text, claimed] of [
    ["CMS125", "CMS125"],
    ["based on cms125v14", "cms125v14"],
    ["CMS122FHIR", "CMS122FHIR"],
    ["MIPS 112", "MIPS 112"],
    ["QID 001", "QID 001"],
    ["Quality ID #236", "Quality ID #236"],
    ["qualityid 309", "qualityid 309"],
  ] as const) {
    assert.equal(claimedCmsIdentity(text), claimed, text);
  }
});

test("a claim form, a rule year and plain prose are not", () => {
  for (const text of ["CMS-1500 billing", "CMS 2026 final rule", "MIPS 2026", "OSHA 29 CFR 1910.95", "Practice policy 4", "CMSABC", "ACMS125"]) {
    assert.equal(claimedCmsIdentity(text), null, text);
    assert.equal(cmsIdentityRefusal("name", text), null, text);
  }
});

test("the refusal names the field and what it found", () => {
  assert.match(cmsIdentityRefusal("policyRef", "per QID 112")!, /^policyRef states a CMS measure identity \("QID 112"\)/);
});

test("names compare trimmed, case-insensitive, inner spaces collapsed", () => {
  assert.ok(sameMeasureName("  Annual   Audiogram ", "annual audiogram"));
  assert.ok(!sameMeasureName("Annual Audiogram", "Annual Audiograms"));
});
