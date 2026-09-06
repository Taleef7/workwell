import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest, manifestSha256, parametersSha256, CORPUS_MEASURE_IDS } from "./corpus-manifest.ts";
import { corpusPatients } from "../../engine/synthetic/corpus/corpus-patient.ts";
import { DEFAULT_CORPUS_SEED, CLINICS, PCPS, CORPUS_GENERATOR_VERSION } from "../../engine/synthetic/corpus/corpus-parameters.ts";

test("the manifest carries every key the spec names, with the declared types", () => {
  const m = buildManifest({
    seed: DEFAULT_CORPUS_SEED,
    patients: corpusPatients(DEFAULT_CORPUS_SEED, 48),
    ndjsonSha256: { Patient: "a".repeat(64) },
  });
  assert.equal(m.generatorVersion, CORPUS_GENERATOR_VERSION);
  assert.equal(m.seed, DEFAULT_CORPUS_SEED);
  assert.equal(m.size, 48);
  assert.equal(m.parametersSha256, parametersSha256());
  for (const key of ["artifactHashes", "terminologySha256s", "realized", "estimatedCohorts", "ndjsonSha256"]) {
    assert.ok(key in m, `manifest is missing ${key}`);
  }
  assert.deepEqual(Object.keys(m.realized.byAgeBand).sort(), ["0-17", "18-44", "45-64", "65+"]);
  assert.deepEqual(Object.keys(m.realized.bySex).sort(), ["F", "M"]);
  assert.equal(Object.keys(m.realized.byClinic).length, CLINICS.length);
  assert.equal(Object.keys(m.realized.byProvider).length, PCPS.length, "every PCP appears, even with a zero panel");
  assert.deepEqual(Object.keys(m.estimatedCohorts).sort(), [...CORPUS_MEASURE_IDS].sort());
});

test("realized counts sum to the corpus size", () => {
  const patients = corpusPatients(DEFAULT_CORPUS_SEED, 2000);
  const m = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients, ndjsonSha256: {} });
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  for (const key of ["byClinic", "byProvider", "byAgeBand", "bySex"] as const) {
    assert.equal(sum(m.realized[key]), 2000, `${key} does not sum to the corpus size`);
  }
});

/**
 * REALIZED and ESTIMATED are different kinds of claim and must not drift into each other: the first is
 * a fact about the generated data, the second is arithmetic over the rate table. A reader who mistakes
 * a projection for a measurement is exactly the failure this separation exists to prevent, so the test
 * pins that they are computed from different things and can disagree.
 */
test("estimated cohorts are arithmetic over the rate table, kept separate from realized facts", () => {
  const patients = corpusPatients(DEFAULT_CORPUS_SEED, 2000);
  const m = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients, ndjsonSha256: {} });

  // cms125's initial population is female AND 42-74 — the artifact's own gate, read off its ELM. It
  // must therefore be strictly smaller than the female count, which is a realized fact.
  assert.ok(
    m.estimatedCohorts.cms125!.initialPopulation < m.realized.bySex.F,
    "cms125's age-gated cohort cannot equal the whole female population",
  );
  // cms122's cohort is diabetics, which is a small share — it must not equal the corpus size.
  assert.ok(m.estimatedCohorts.cms122!.initialPopulation > 0);
  assert.ok(m.estimatedCohorts.cms122!.initialPopulation < patients.length);
  // Every rate is a probability.
  for (const [id, cohort] of Object.entries(m.estimatedCohorts)) {
    assert.ok(cohort.expectedNumeratorRate >= 0 && cohort.expectedNumeratorRate <= 1, `${id}: rate out of range`);
    assert.ok(cohort.denominator <= cohort.initialPopulation, `${id}: denominator exceeds the initial population`);
  }
});

test("artifact and terminology hashes come from each measure's committed manifest, not recomputed", () => {
  const m = buildManifest({
    seed: DEFAULT_CORPUS_SEED,
    patients: corpusPatients(DEFAULT_CORPUS_SEED, 10),
    ndjsonSha256: {},
    loadArtifact: (id) => ({ manifest: { sha256: `sha256:${id}-bundle`, terminology: { sha256: `sha256:${id}-tx` } } }) as never,
  });
  for (const id of CORPUS_MEASURE_IDS) {
    assert.equal(m.artifactHashes[id], `sha256:${id}-bundle`);
    assert.equal(m.terminologySha256s[id], `sha256:${id}-tx`);
  }
  // A measure with no vendored artifact reads as null rather than being silently omitted — an absent
  // key would let a consumer conclude the measure was not part of the corpus at all.
  const missing = buildManifest({
    seed: DEFAULT_CORPUS_SEED,
    patients: corpusPatients(DEFAULT_CORPUS_SEED, 10),
    ndjsonSha256: {},
    loadArtifact: () => null,
  });
  for (const id of CORPUS_MEASURE_IDS) {
    assert.ok(id in missing.artifactHashes, `${id} must still appear`);
    assert.equal(missing.artifactHashes[id], null);
  }
});

test("buildManifest is pure and its digest is stable", () => {
  const patients = corpusPatients(DEFAULT_CORPUS_SEED, 48);
  const a = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients, ndjsonSha256: {} });
  const b = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients, ndjsonSha256: {} });
  assert.deepEqual(a, b);
  assert.equal(manifestSha256(a), manifestSha256(b));
  // `generatedAt` is injected rather than read from a clock, so a manifest built twice is identical.
  assert.equal("generatedAt" in a, false, "no wall-clock value leaks in unless the caller passes one");
  const stamped = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients, ndjsonSha256: {}, generatedAt: "2027-01-01T00:00:00Z" });
  assert.equal(stamped.generatedAt, "2027-01-01T00:00:00Z");
});
