import test from "node:test";
import assert from "node:assert/strict";
import { CORPUS_FIXTURE_PREFIX } from "./corpus-fixture-prefix.ts";
import {
  CLINICS,
  PCPS,
  PCPS_PER_CLINIC,
  CLINIC_WEIGHTS,
  AGE_MIXTURE,
  CONDITION_PREVALENCE,
  EVENT_RATES,
  parametersSha256,
} from "./corpus-parameters.ts";

test("the fixture prefix is exactly the 48 pat-001..pat-048 rows", () => {
  assert.equal(CORPUS_FIXTURE_PREFIX.length, 48);
  assert.equal(CORPUS_FIXTURE_PREFIX[0]!.externalId, "pat-001");
  assert.equal(CORPUS_FIXTURE_PREFIX[47]!.externalId, "pat-048");
  assert.ok(CORPUS_FIXTURE_PREFIX.every((p) => p.tenantId === "maui" && p.role === "Patient"));
});

test("there are five clinics and forty PCPs, staffed to the panel, and the first four PCPs are the existing ids", () => {
  assert.deepEqual(CLINICS.map((c) => c.name), ["Wailuku Clinic", "Kahului Clinic", "Kihei Clinic", "Lahaina Clinic", "Pukalani Clinic"]);
  assert.equal(PCPS.length, 40);
  assert.equal(PCPS_PER_CLINIC.reduce((a, b) => a + b, 0), 40);
  for (const [i, clinic] of CLINICS.entries()) {
    assert.equal(PCPS.filter((p) => p.location === clinic.name).length, PCPS_PER_CLINIC[i], `${clinic.name} PCP count`);
  }
  // The panel bound is only reachable because PCP count scales with weight — see CLINIC_WEIGHTS' note.
  for (const [i, [, weight]] of CLINIC_WEIGHTS.entries()) {
    const expected = (20000 * weight) / PCPS_PER_CLINIC[i]!;
    assert.ok(expected >= 400 && expected <= 600, `${CLINICS[i]!.name} expected panel ${expected}`);
  }
  assert.deepEqual(PCPS.slice(0, 4).map((p) => p.id), ["maui-prov-001", "maui-prov-002", "maui-prov-003", "maui-prov-004"]);
  assert.ok(PCPS.every((p) => /^maui-prov-\d{3}$/.test(p.id)), "PCP ids are pseudonymous");
  assert.equal(new Set(PCPS.map((p) => p.id)).size, 40, "PCP ids are unique");
});

test("clinic weights sum to 1 and every clinic is represented", () => {
  const total = CLINIC_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  assert.deepEqual(CLINIC_WEIGHTS.map(([name]) => name).sort(), CLINICS.map((c) => c.name).sort());
});

test("every prevalence and rate is a probability", () => {
  const all = [...Object.values(CONDITION_PREVALENCE).flatMap((band) => Object.values(band)), ...Object.values(EVENT_RATES)];
  for (const value of all) assert.ok(typeof value === "number" && value >= 0 && value <= 1, `not a probability: ${value}`);
  assert.ok(Math.abs(AGE_MIXTURE.reduce((sum, c) => sum + c.weight, 0) - 1) < 1e-9);
});

// Named for what it actually checks. Whether the digest MOVES when a row changes is a property of
// JSON.stringify over the table, not something this test can exercise against module-level consts —
// asserting it here would be a claim the test never makes.
test("parametersSha256 is a pure, stable hex digest", () => {
  assert.match(parametersSha256(), /^[0-9a-f]{64}$/);
  assert.equal(parametersSha256(), parametersSha256(), "pure");
});
