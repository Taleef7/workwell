/**
 * The identity a CMS library takes once WorkWell has edited it: measure-agnostic, so one edit of one CMS
 * library for one year is one Library resource whichever translation carries it (#782).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { translationIdentity } from "./derived-build.ts";
import { changedLibraryIdentity, includedLibraryName } from "./derived-changed-library.ts";

test("a changed library is named for the CMS library, its year and the translation's version, never for the measure", () => {
  const for130 = changedLibraryIdentity("AdvancedIllnessandFrailty", "1.27.000", translationIdentity("cms130", 2027, "CMS130v15"));
  assert.deepEqual(for130, {
    name: "WorkWellAdvancedIllnessandFrailtyTranslation2027",
    version: "ww-2027.1",
    url: "urn:workwell:library:WorkWellAdvancedIllnessandFrailtyTranslation2027",
    title: "WorkWell translation of CMS's AdvancedIllnessandFrailty 1.27.000, for 2027",
  });
  // CMS125 makes the same edit to the same library for the same year: the same resource identity, title
  // included, so `url|version` never names two different resources.
  assert.deepEqual(changedLibraryIdentity("AdvancedIllnessandFrailty", "1.27.000", translationIdentity("cms125", 2027, "CMS125v15")), for130);
  assert.equal(changedLibraryIdentity("Hospice", "6.18.000", translationIdentity("cms125", 2028, "CMS125v16", 2)).title, "WorkWell translation of CMS's Hospice 6.18.000, for 2028");
  assert.throws(() => changedLibraryIdentity("Advanced Illness", "1", translationIdentity("cms125", 2027, "CMS125v15")), /not a plain CQL identifier/);
  assert.throws(() => changedLibraryIdentity("A".repeat(60), "1", translationIdentity("cms125", 2027, "CMS125v15")), /longer than a FHIR id may be/);
});

test("an include path names its library by what follows the last slash, as the engine resolves it", () => {
  assert.equal(includedLibraryName("https://madie.cms.gov/FHIRHelpers"), "FHIRHelpers");
  assert.equal(includedLibraryName("WorkWellAdvancedIllnessandFrailtyTranslation2027"), "WorkWellAdvancedIllnessandFrailtyTranslation2027");
});
