/**
 * `routedTranslationFor` answers from the manifests what the executor answers from the artifacts
 * (`selectArtifactForPeriod`), for screens that only name the logic.
 *   node --import tsx --test src/wiring/translation-routing.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routedTranslationFor, routedTranslationYear } from "./translation-routing.ts";
import { selectArtifactForPeriod, type OfficialArtifact, type OfficialManifest } from "./official-artifacts.ts";

const manifest = (start: string, end: string, derived = false): OfficialManifest =>
  ({ catalogId: "cms137", effectivePeriod: { start, end }, ...(derived ? { derived: { label: "WorkWell translation of CMS137v15" } } : {}) }) as never;
const CMS_2026 = manifest("2026-01-01", "2026-12-31");
const TRANSLATION_2027 = manifest("2027-01-01", "2027-12-31", true);
const ROUTED = { WORKWELL_OFFICIAL_MEASURES: "cms137", WORKWELL_DERIVED_MEASURES: "cms137" };
const files = (official: OfficialManifest | null, derived: OfficialManifest | null) => ({ official: () => official, derived: () => derived });

test("names the translation for the year it covers, by the executor's own rule", () => {
  const cases: Array<[string, Record<string, string>, number, OfficialManifest | null, OfficialManifest | null, boolean]> = [
    ["routed, 2027", ROUTED, 2027, CMS_2026, TRANSLATION_2027, true],
    ["routed, 2026: CMS's artifact covers it", ROUTED, 2026, CMS_2026, TRANSLATION_2027, false],
    ["routed, 2028: nothing covers it, CMS's artifact scores it with the old-logic note", ROUTED, 2028, CMS_2026, TRANSLATION_2027, false],
    ["not allowlisted", { WORKWELL_OFFICIAL_MEASURES: "cms137" }, 2027, CMS_2026, TRANSLATION_2027, false],
    ["allowlisted but not official-routed", { WORKWELL_DERIVED_MEASURES: "cms137" }, 2027, CMS_2026, TRANSLATION_2027, false],
    ["no translation committed", ROUTED, 2027, CMS_2026, null, false],
    ["no CMS artifact", ROUTED, 2027, null, TRANSLATION_2027, false],
    ["a CMS artifact covering 2027 wins", ROUTED, 2027, manifest("2027-01-01", "2027-12-31"), TRANSLATION_2027, false],
  ];
  for (const [label, env, year, official, derived, named] of cases) {
    const got = routedTranslationFor("cms137", year, env, files(official, derived));
    assert.equal(got !== null, named, label);
    // The same answer the executor reaches over the same files.
    if (official) {
      const asArtifact = (m: OfficialManifest | null, kind: "official" | "derived") => (m ? ({ kind, manifest: m } as OfficialArtifact) : null);
      const routedDerived = env.WORKWELL_DERIVED_MEASURES && env.WORKWELL_OFFICIAL_MEASURES ? asArtifact(derived, "derived") : null;
      const chosen = selectArtifactForPeriod({ official: asArtifact(official, "official"), derived: routedDerived }, { start: `${year}-01-01`, end: `${year}-12-31` });
      assert.equal(chosen?.kind === "derived", named, `${label}: agrees with selectArtifactForPeriod`);
    }
  }
  assert.equal(routedTranslationFor("cms137", 2027, ROUTED, files(CMS_2026, TRANSLATION_2027))?.derived?.label, "WorkWell translation of CMS137v15");
});

test("routedTranslationYear names the translation's year only while the executor would select it", () => {
  assert.equal(routedTranslationYear("cms137", ROUTED, files(CMS_2026, TRANSLATION_2027)), 2027);
  assert.equal(routedTranslationYear("cms137", ROUTED, files(manifest("2027-01-01", "2027-12-31"), TRANSLATION_2027)), null, "CMS's artifact now covers 2027: CMS wins, the translation never runs");
  assert.equal(routedTranslationYear("cms137", { WORKWELL_OFFICIAL_MEASURES: "cms137" }, files(CMS_2026, TRANSLATION_2027)), null, "not allowlisted");
  assert.equal(routedTranslationYear("cms137", ROUTED, files(CMS_2026, null)), null, "none committed");
  assert.equal(routedTranslationYear("cms137", ROUTED, files(CMS_2026, manifest("2027-01-01", "2028-12-31", true))), null, "never a span of years");
});

test("reads the real deployment by default: nothing is allowlisted and no translation is committed", () => {
  assert.equal(routedTranslationFor("cms137", 2027, {}), null);
  assert.equal(routedTranslationFor("cms137", 2027, ROUTED), null, "C2 commits no translation");
});
