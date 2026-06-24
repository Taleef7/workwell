/** generateCql — deterministic CQL from rule-params, per shape.
 *   node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCql } from "./generate-cql.ts";

const SERIES_CODES = {
  enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
  waiver: { code: "mmr-contraindication", valueSet: "urn:workwell:vs:mmr-contraindication" },
  event: { code: "mmr-vaccine", valueSet: "urn:workwell:vs:mmr-vaccines", type: "immunization" as const },
  refusal: { code: "mmr-refusal", valueSet: "urn:workwell:vs:mmr-refusal" },
};

test("series-completion emits the dose-count CQL with the required-doses threshold", () => {
  const cql = generateCql({
    library: "MmrSeries", version: "1.0.0",
    rule: { type: "series-completion", requiredDoses: 2 },
    bindings: SERIES_CODES,
  });
  assert.match(cql, /^library MmrSeries version '1\.0\.0'/);
  assert.match(cql, /define "Dose Count":/);
  assert.match(cql, /\[Immunization\] I\s+where I\.status = 'completed'/);
  assert.match(cql, /C\.system = 'urn:workwell:vs:mmr-vaccines' and C\.code = 'mmr-vaccine'/);
  assert.match(cql, /"Dose Count" >= 2/);
  assert.match(cql, /define "Outcome Status":/);
  assert.match(cql, /if "Excluded" then 'EXCLUDED'/);
  assert.match(cql, /else if "Series Complete" then 'COMPLIANT'/);
  assert.match(cql, /define "Has Contraindication":/);
  assert.match(cql, /define "Refused":/);
});

test("windowed-recency emits the days-since ladder with the compliant/due-soon bands", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
    },
  });
  assert.match(cql, /^library AnnualAudiogramCompleted version '1\.0\.0'/);
  assert.match(cql, /define "Most Recent Event Date":/);
  assert.match(cql, /define "Days Since Last Event":/);
  assert.match(cql, /\[Procedure\] P/);
  assert.match(cql, /"Days Since Last Event" <= 335/);
  assert.match(cql, /"Days Since Last Event" > 335 and "Days Since Last Event" <= 365/);
  assert.match(cql, /"Days Since Last Event" > 365/);
  assert.match(cql, /else if "Compliant" then 'COMPLIANT'/);
});

test("an unknown rule type throws", () => {
  // @ts-expect-error — deliberate bad type
  assert.throws(() => generateCql({ library: "X", version: "1.0.0", rule: { type: "nope" }, bindings: SERIES_CODES }));
});

test("windowed compliantMax = windowDays - dueSoonDays (catches an off-by-one with a NON-default band)", () => {
  // All migrated measures use dueSoonDays:30 (→335); use 60 here so a wrong `windowDays + dueSoonDays`
  // (=425) or any other miscompute can't pass on the hardcoded 335.
  const cql = generateCql({
    library: "X", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 60 },
    bindings: {
      enrollment: { code: "e", valueSet: "urn:vs:e" },
      waiver: { code: "w", valueSet: "urn:vs:w" },
      event: { code: "ev", valueSet: "urn:vs:ev", type: "procedure" },
    },
  });
  assert.match(cql, /"Days Since Last Event" <= 305/);                                  // 365 - 60
  assert.match(cql, /"Days Since Last Event" > 305 and "Days Since Last Event" <= 365/);
  assert.doesNotMatch(cql, /<= 425|<= 335/);
});
