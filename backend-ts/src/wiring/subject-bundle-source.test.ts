import test from "node:test";
import assert from "node:assert/strict";
import { bindingBundleSource, compositeBundleSource } from "./subject-bundle-source.ts";
import { employees } from "../config/deployment-profile.ts";
import { seededDistribution, seededTargetFor } from "../run/distribution.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";

test("bindingBundleSource reproduces today's distribution, target and bundle bytes for an authored measure", () => {
  const src = bindingBundleSource();
  const e = employees()[0]!;
  assert.deepEqual(src.distribution(employees(), "audiogram"), seededDistribution(employees(), MEASURE_BINDINGS.audiogram!.rateKey));
  assert.equal(src.targetFor(employees(), "audiogram", e.externalId), seededTargetFor(employees(), "audiogram", e.externalId));
  const target = src.targetFor(employees(), "audiogram", e.externalId)!;
  assert.deepEqual(src.bundleFor(e, "audiogram", target, "2026-06-01"), buildSyntheticBundle(e, deriveExamConfig(MEASURE_BINDINGS.audiogram!, target), "2026-06-01"));
});

test("compositeBundleSource refuses an id it cannot classify as authored or official", () => {
  const src = compositeBundleSource({});
  assert.throws(() => src.bundleFor(employees()[0]!, "cms137", "COMPLIANT", "2026-06-01"), /not runnable/);
});

test("every authored binding's rateKey IS its measure id — the seam and backfill-trend-history assume it", () => {
  // `backfill-trend-history.ts` sets `rateKey = measureId` now that it goes through the seam rather
  // than reaching into MEASURE_BINDINGS. That is true of all 14 bindings today and silently changes
  // every historical rate if it ever stops being true, so it is pinned rather than assumed.
  const divergent = Object.entries(MEASURE_BINDINGS)
    .filter(([id, binding]) => binding.rateKey !== id)
    .map(([id, binding]) => `${id} -> ${binding.rateKey}`);
  assert.deepEqual(divergent, [], "a binding whose rateKey is not its measure id needs the seam to carry rateKey explicitly");
});
