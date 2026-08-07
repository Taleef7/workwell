/**
 * @work-well/official-executor unit tests — pure, no fqm-execution loaded.
 *   node --import tsx --test packages/official-executor/src/index.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildValueSetCache,
  calculateOfficial,
  calculationOptions,
  hasRetrieveSignal,
  isExecutableMeasureBundle,
  normalizePeriodEnd,
  oidFromValueSetUrl,
  populationMembership,
  referencedValueSetUrls,
  type MeasureBundle,
} from "./index.ts";

const elmLibrary = (valueSetIds: string[]) => ({
  resource: {
    resourceType: "Library",
    content: [
      {
        contentType: "application/elm+json",
        data: Buffer.from(
          JSON.stringify({ library: { valueSets: { def: valueSetIds.map((id) => ({ id })) } } }),
          "utf8",
        ).toString("base64"),
      },
    ],
  },
});

test("isExecutableMeasureBundle requires a Measure and ELM on EVERY library", () => {
  const measure = { resource: { resourceType: "Measure" } };
  assert.equal(isExecutableMeasureBundle({ resourceType: "Bundle", entry: [measure, elmLibrary([])] }), true);

  // A library without pre-compiled ELM would force runtime translation — reject the whole bundle.
  const noElm = { resource: { resourceType: "Library", content: [{ contentType: "text/cql", data: "x" }] } };
  assert.equal(isExecutableMeasureBundle({ resourceType: "Bundle", entry: [measure, elmLibrary([]), noElm] }), false);
  assert.equal(isExecutableMeasureBundle({ resourceType: "Bundle", entry: [measure] }), false, "no libraries");
  assert.equal(isExecutableMeasureBundle({ resourceType: "Bundle", entry: [elmLibrary([])] }), false, "no Measure");
  for (const junk of [null, undefined, {}, { resourceType: "Bundle" }, "nope", 42]) {
    assert.equal(isExecutableMeasureBundle(junk), false, `junk input: ${String(junk)}`);
  }
});

test("referencedValueSetUrls unions across libraries", () => {
  const bundle = {
    resourceType: "Bundle",
    entry: [
      { resource: { resourceType: "Measure" } },
      elmLibrary(["http://cts.nlm.nih.gov/fhir/ValueSet/1.2.3", "http://cts.nlm.nih.gov/fhir/ValueSet/4.5.6"]),
      elmLibrary(["http://cts.nlm.nih.gov/fhir/ValueSet/1.2.3"]), // duplicate → unioned
    ],
  } as unknown as MeasureBundle;
  assert.deepEqual(referencedValueSetUrls(bundle).sort(), [
    "http://cts.nlm.nih.gov/fhir/ValueSet/1.2.3",
    "http://cts.nlm.nih.gov/fhir/ValueSet/4.5.6",
  ]);
});

test("oidFromValueSetUrl strips the canonical prefix, passes a bare oid through", () => {
  assert.equal(oidFromValueSetUrl("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464"), "2.16.840.1.113883.3.464");
  assert.equal(oidFromValueSetUrl("2.16.840.1.113883.3.464"), "2.16.840.1.113883.3.464");
});

test("oidFromValueSetUrl strips a `|version` suffix — a versioned canonical is the SAME value set", () => {
  // Review of #364. A FHIR canonical may carry `|version`; a shipped `ValueSet.url` never does (the
  // version lives in `ValueSet.version`). Without this, an ELM declaring `…|1.2` keys as `2.16.1|1.2`
  // while the artifact's terminology keys as `2.16.1` — so the value set reads as ABSENT though present,
  // routing refuses a measure that is fine, and `--complete-terminology` asks VSAC for a malformed
  // version-suffixed id. Measured: zero versioned canonicals across all six upstream bundles at the
  // pinned commit, so this is latent rather than live — and asserted rather than left to be rediscovered.
  assert.equal(
    oidFromValueSetUrl("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464|1.2"),
    "2.16.840.1.113883.3.464",
  );
  assert.equal(oidFromValueSetUrl("2.16.840.1.113883.3.464|20250101"), "2.16.840.1.113883.3.464");
  // Both forms must land on ONE key, which is the property `absentValueSets`' de-duplication assumes.
  assert.equal(
    oidFromValueSetUrl("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.1|1.2"),
    oidFromValueSetUrl("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.1"),
  );
});

test("buildValueSetCache emits a failed expansion EMPTY-but-PRESENT rather than omitting it", async () => {
  const bundle = {
    resourceType: "Bundle",
    entry: [
      { resource: { resourceType: "Measure" } },
      elmLibrary(["http://cts.nlm.nih.gov/fhir/ValueSet/ok", "http://cts.nlm.nih.gov/fhir/ValueSet/boom"]),
    ],
  } as unknown as MeasureBundle;
  const cache = (await buildValueSetCache(bundle, async (oid) => {
    if (oid === "boom") throw new Error("VSAC down");
    return [{ code: "1", system: "http://loinc.org" }];
  })) as Array<{ id: string; expansion: { contains: unknown[] } }>;

  assert.equal(cache.length, 2, "a missing value set would abort the whole fqm batch — never omit one");
  assert.equal(cache.find((v) => v.id === "boom")?.expansion.contains.length, 0);
  assert.equal(cache.find((v) => v.id === "ok")?.expansion.contains.length, 1);
});

test("normalizePeriodEnd fixes the fqm#371 date-only start-of-day parse, and only that", () => {
  assert.equal(normalizePeriodEnd("2026-12-31"), "2026-12-31T23:59:59.999Z");
  const alreadyTimed = "2026-12-31T18:00:00.000Z";
  assert.equal(normalizePeriodEnd(alreadyTimed), alreadyTimed, "an explicit instant must be left alone");
});

test("calculationOptions pins the flags that cost CPU or silently do nothing", () => {
  const options = calculationOptions({ start: "2026-01-01", end: "2026-12-31" });
  assert.equal(options["measurementPeriodEnd"], "2026-12-31T23:59:59.999Z");
  assert.equal(options["calculateHTML"], false, "fqm 1.8.5 reads calculateHTML, not disableHTMLGeneration");
  assert.equal(options["calculateClauseCoverage"], false);
  assert.equal(options["calculateRAVs"], false);
  assert.equal(options["verboseCalculationResults"], true, "population membership lives in detailedResults");
  assert.equal(options["trustMetaProfile"], false, "plain-FHIR bundles retrieve by base type");
  assert.equal(calculationOptions({ start: "a", end: "b" }, { trustMetaProfile: true })["trustMetaProfile"], true);
});

test("hasRetrieveSignal distinguishes 'nobody qualified' from 'nothing was retrieved'", () => {
  assert.equal(hasRetrieveSignal({ results: [] }), false);
  assert.equal(
    hasRetrieveSignal({ results: [{ evaluatedResource: [{ resourceType: "Patient" }], detailedResults: [{ populationResults: [] }] }] }),
    false,
    "only the Patient retrieved + nobody in any population = the profile-mismatch signature",
  );
  assert.equal(hasRetrieveSignal({ results: [{ evaluatedResource: [{ resourceType: "Observation" }] }] }), true);
  assert.equal(
    hasRetrieveSignal({ results: [{ detailedResults: [{ populationResults: [{ populationType: "numerator", result: true }] }] }] }),
    true,
  );
});

test("populationMembership reduces fqm's array to a code→boolean map", () => {
  assert.deepEqual(
    populationMembership([
      { populationType: "initial-population", result: true },
      { populationType: "denominator", result: true },
      { populationType: "numerator", result: false },
    ]),
    { "initial-population": true, denominator: true, numerator: false },
  );
});

test("calculateOfficial batches once and keys membership by patient id", async () => {
  let calls = 0;
  let seenOptions: Record<string, unknown> = {};
  const bySubject = await calculateOfficial({
    bundle: { resourceType: "Bundle", entry: [] } as unknown as MeasureBundle,
    patientBundles: [{ id: "a" }, { id: "b" }],
    period: { start: "2026-01-01", end: "2026-12-31" },
    calculate: async (_bundle, patients, options) => {
      calls += 1;
      seenOptions = options as Record<string, unknown>;
      assert.equal(patients.length, 2, "one batch, not one call per subject (the ELM parses once)");
      return {
        results: [
          { patientId: "a", detailedResults: [{ populationResults: [{ populationType: "numerator", result: true }] }] },
          { patientId: "b", detailedResults: [{ populationResults: [{ populationType: "numerator", result: false }] }] },
          { patientId: "c" }, // no detailedResults → absent from the map; the caller decides if that is an error
        ],
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(seenOptions["measurementPeriodEnd"], "2026-12-31T23:59:59.999Z");
  assert.deepEqual([...bySubject.keys()].sort(), ["a", "b"]);
  assert.equal(bySubject.get("a")?.["numerator"], true);
  assert.equal(bySubject.get("b")?.["numerator"], false);
});

test("referencedValueSetUrls FAILS FAST on unparseable ELM rather than silently dropping retrieves", () => {
  // Swallowing this would trade a precise parse error for an opaque cql-execution "ValueSet not found"
  // deep inside the fqm batch — the pre-extraction code threw, and so does this.
  const bundle = {
    resourceType: "Bundle",
    entry: [
      { resource: { resourceType: "Measure" } },
      { resource: { resourceType: "Library", content: [{ contentType: "application/elm+json", data: "!!not-json" }] } },
    ],
  } as unknown as MeasureBundle;
  assert.throws(() => referencedValueSetUrls(bundle));
});

test("isExecutableMeasureBundle rejects a bundle with a null/resource-less entry (sound narrowing)", () => {
  // The guard is the precondition referencedValueSetUrls trusts when it dereferences entry.resource.
  const withNull = {
    resourceType: "Bundle",
    entry: [{ resource: { resourceType: "Measure" } }, elmLibrary([]), null],
  };
  assert.equal(isExecutableMeasureBundle(withNull), false);
  assert.equal(isExecutableMeasureBundle({ resourceType: "Bundle", entry: [{ resource: { resourceType: "Measure" } }, elmLibrary([]), {}] }), false);
});

test("populationMembership resolves duplicate populationTypes FIRST-wins (pre-extraction semantics)", () => {
  const membership = populationMembership([
    { populationType: "numerator", result: true },
    { populationType: "numerator", result: false },
  ]);
  assert.equal(membership["numerator"], true, "a later duplicate must not overwrite the first");
});

test("calculateOfficial can express trustMetaProfile, so both consumers can share it", async () => {
  let seen: Record<string, unknown> = {};
  await calculateOfficial({
    bundle: { resourceType: "Bundle", entry: [] } as unknown as MeasureBundle,
    patientBundles: [],
    period: { start: "2026-01-01", end: "2026-12-31" },
    options: { trustMetaProfile: true },
    calculate: async (_b, _p, options) => { seen = options as Record<string, unknown>; return { results: [] }; },
  });
  assert.equal(seen["trustMetaProfile"], true);
});
