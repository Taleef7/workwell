/** generateCql — deterministic CQL from rule-params, per shape.
 *   node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCql, type Rule, type CodegenBindings } from "./generate-cql.ts";

/** E11.2c helper — build CQL from a rule + bindings with a fixed library/version. */
const gen = (rule: Rule, bindings: CodegenBindings): string =>
  generateCql({ library: "Lib", version: "1.0.0", rule, bindings });

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

test("titer: when allowPositiveTiter + a titer binding, Series Complete ORs in Has Positive Titer", () => {
  const cql = generateCql({
    library: "MmrSeries", version: "1.0.0",
    rule: { type: "series-completion", requiredDoses: 2, allowPositiveTiter: true },
    bindings: { ...SERIES_CODES, titer: { code: "mmr-titer", valueSet: "urn:workwell:vs:mmr-titer", minValue: 10 } },
  });
  assert.match(cql, /define "Has Positive Titer":/);
  assert.match(cql, /C\.system = 'urn:workwell:vs:mmr-titer' and C\.code = 'mmr-titer'/);
  assert.match(cql, /\(O\.value as FHIR\.Quantity\)\.value >= 10/);
  assert.match(cql, /"Dose Count" >= 2 or "Has Positive Titer"/);
});

test("titer: disabled (default) reproduces the E11.1 series output — no titer define, plain Series Complete", () => {
  const cql = generateCql({
    library: "MmrSeries", version: "1.0.0",
    rule: { type: "series-completion", requiredDoses: 2 },
    bindings: SERIES_CODES,
  });
  assert.doesNotMatch(cql, /Has Positive Titer/);
  assert.match(cql, /"Enrolled" and not "Has Contraindication" and "Dose Count" >= 2\n/);
});

test("grace: overdueThreshold = windowDays + gracePeriodDays shifts the OVERDUE boundary", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30, gracePeriodDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
    },
  });
  assert.match(cql, /"Days Since Last Event" > 335 and "Days Since Last Event" <= 395/);
  assert.match(cql, /define "Overdue":\n  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > 395/);
});

test("grace: absent (default) reproduces the E11.1 windowed output (overdueThreshold = windowDays)", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
    },
  });
  assert.match(cql, /"Days Since Last Event" > 335 and "Days Since Last Event" <= 365/);
  assert.match(cql, /"Days Since Last Event" > 365\n/);
  assert.doesNotMatch(cql, /<= 395|> 395/);
  assert.doesNotMatch(cql, /define "Refused"/); // no refusal binding → no Refused define
});

test("alternatives: emits a per-alternative Complete define + a union Dose Count, no single Dose Count >= N", () => {
  const cql = gen(
    { type: "series-completion", requiredDoses: 2, alternatives: [
      { label: "Heplisav-B", requiredDoses: 2, minIntervalDays: [28] },
      { label: "Traditional", requiredDoses: 3, minIntervalDays: [28, 56] },
    ] },
    { enrollment: { code: "e", valueSet: "urn:vs:enr" }, waiver: { code: "w", valueSet: "urn:vs:wai" },
      event: { code: "hepb", valueSet: "urn:workwell:vs:hepb-vaccines", type: "immunization" },
      eventAlternatives: [
        { label: "Heplisav-B", codes: [{ code: "189", valueSet: "urn:workwell:vs:hepb-vaccines" }] },
        { label: "Traditional", codes: [{ code: "08", valueSet: "urn:workwell:vs:hepb-vaccines" }, { code: "43", valueSet: "urn:workwell:vs:hepb-vaccines" }] },
      ] }
  );
  assert.match(cql, /define "Heplisav-B Complete":/);
  assert.match(cql, /define "Traditional Complete":/);
  assert.match(cql, /define "Dose Count":/);
  assert.match(cql, /"Heplisav-B Complete" or "Traditional Complete"/);
  assert.match(cql, /difference in days between .* >= 28/);
  assert.doesNotMatch(cql, /"Dose Count" >= 2/);
});

test("alternatives: a declared alternative with no matching eventAlternatives entry throws", () => {
  assert.throws(
    () => gen(
      { type: "series-completion", requiredDoses: 2, alternatives: [{ label: "Heplisav-B", requiredDoses: 2 }] },
      { enrollment: { code: "e", valueSet: "v" }, waiver: { code: "w", valueSet: "v" },
        event: { code: "x", valueSet: "v", type: "immunization" },
        eventAlternatives: [{ label: "Traditional", codes: [{ code: "08", valueSet: "v" }] }] },
    ),
    /no eventAlternatives codes/,
  );
});

test("alternatives: minIntervalDays length != requiredDoses-1 throws", () => {
  assert.throws(
    () => gen(
      { type: "series-completion", requiredDoses: 2, alternatives: [{ label: "Traditional", requiredDoses: 3, minIntervalDays: [28] }] },
      { enrollment: { code: "e", valueSet: "v" }, waiver: { code: "w", valueSet: "v" },
        event: { code: "x", valueSet: "v", type: "immunization" },
        eventAlternatives: [{ label: "Traditional", codes: [{ code: "08", valueSet: "v" }] }] },
    ),
    /minIntervalDays length must equal requiredDoses-1/,
  );
});

test("alternatives: requiredDoses < 1 throws", () => {
  assert.throws(
    () => gen(
      { type: "series-completion", requiredDoses: 1, alternatives: [{ label: "Traditional", requiredDoses: 0 }] },
      { enrollment: { code: "e", valueSet: "v" }, waiver: { code: "w", valueSet: "v" },
        event: { code: "x", valueSet: "v", type: "immunization" },
        eventAlternatives: [{ label: "Traditional", codes: [{ code: "08", valueSet: "v" }] }] },
    ),
    /requiredDoses must be >= 1/,
  );
});

test("alternatives: a single-dose alternative with empty minIntervalDays is count-only (no malformed interval exists)", () => {
  const cql = gen(
    { type: "series-completion", requiredDoses: 1, alternatives: [{ label: "Single", requiredDoses: 1, minIntervalDays: [] }] },
    { enrollment: { code: "e", valueSet: "v" }, waiver: { code: "w", valueSet: "v" },
      event: { code: "x", valueSet: "v", type: "immunization" },
      eventAlternatives: [{ label: "Single", codes: [{ code: "189", valueSet: "v" }] }] },
  );
  assert.match(cql, /Count\("Single Dose Dates"\) >= 1/);
  assert.doesNotMatch(cql, /exists\(from "Single Dose Dates"/);
});

test("alternatives absent: series output is unchanged from the single-code path", () => {
  const single = gen({ type: "series-completion", requiredDoses: 2 },
    { enrollment: { code: "e", valueSet: "v" }, waiver: { code: "w", valueSet: "v" }, event: { code: "x", valueSet: "v", type: "immunization" } });
  assert.match(single, /"Dose Count" >= 2/);
  assert.doesNotMatch(single, /Complete":\n  exists/);
});

test("declination: a windowed rule with a refusal binding emits the Refused define", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
      refusal: { code: "audiogram-refusal", valueSet: "urn:workwell:vs:audiogram-refusal" },
    },
  });
  assert.match(cql, /define "Refused":/);
  assert.match(cql, /x\.system = 'urn:workwell:vs:audiogram-refusal' and x\.code = 'audiogram-refusal'/);
});

// --- Fable M19: reject degenerate numeric params (would compile clean but be silently wrong) --------
const WINDOWED_CODES: CodegenBindings = {
  enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
  waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
  event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
};

test("M19: series-completion requiredDoses < 1 throws (was: everyone COMPLIANT with 0 doses)", () => {
  assert.throws(() => gen({ type: "series-completion", requiredDoses: 0 }, SERIES_CODES), /requiredDoses must be >= 1/);
  assert.throws(() => gen({ type: "series-completion", requiredDoses: -2 }, SERIES_CODES), /requiredDoses must be >= 1/);
  assert.throws(() => gen({ type: "series-completion", requiredDoses: 1.5 }, SERIES_CODES), /requiredDoses must be an integer/);
});

test("M19: windowed-recency dueSoonDays >= windowDays throws (was: COMPLIANT unreachable)", () => {
  assert.throws(() => gen({ type: "windowed-recency", windowDays: 30, dueSoonDays: 35 }, WINDOWED_CODES), /must be < windowDays/);
  assert.throws(() => gen({ type: "windowed-recency", windowDays: 365, dueSoonDays: 365 }, WINDOWED_CODES), /must be < windowDays/);
  assert.throws(() => gen({ type: "windowed-recency", windowDays: 0, dueSoonDays: 0 }, WINDOWED_CODES), /windowDays must be >= 1/);
  assert.throws(() => gen({ type: "windowed-recency", windowDays: 365, dueSoonDays: -1 }, WINDOWED_CODES), /dueSoonDays must be >= 0/);
  assert.throws(() => gen({ type: "windowed-recency", windowDays: 365, dueSoonDays: 30, gracePeriodDays: -5 }, WINDOWED_CODES), /gracePeriodDays must be >= 0/);
});

test("M19: valid params still generate (guard doesn't reject the real measures)", () => {
  assert.match(gen({ type: "series-completion", requiredDoses: 2 }, SERIES_CODES), /"Dose Count" >= 2/);
  assert.match(gen({ type: "windowed-recency", windowDays: 365, dueSoonDays: 30 }, WINDOWED_CODES), /define "Outcome Status":/);
});
