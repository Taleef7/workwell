import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { patientAt, corpusPatients } from "./corpus-patient.ts";
import { CORPUS_FIXTURE_PREFIX } from "./corpus-fixture-prefix.ts";
import { CLINICS, PCPS, DEFAULT_CORPUS_SEED } from "./corpus-parameters.ts";

test("the first 48 patients are the fixture prefix verbatim", () => {
  for (const [i, fixture] of CORPUS_FIXTURE_PREFIX.entries()) {
    const p = patientAt(DEFAULT_CORPUS_SEED, i);
    assert.equal(p.externalId, fixture.externalId);
    assert.equal(p.name, fixture.name);
    assert.equal(p.site, fixture.site);
    assert.equal(p.dateOfBirth, fixture.dateOfBirth);
  }
});

test("generated ids start at pat-00049 and are zero-padded to five digits", () => {
  assert.equal(patientAt(DEFAULT_CORPUS_SEED, 48).externalId, "pat-00049");
  assert.equal(patientAt(DEFAULT_CORPUS_SEED, 19999).externalId, "pat-20000");
});

test("patientAt is pure: same (seed, index) gives a byte-identical record", () => {
  const a = patientAt(DEFAULT_CORPUS_SEED, 5000);
  const b = patientAt(DEFAULT_CORPUS_SEED, 5000);
  assert.deepEqual(a, b);
});

test("generation order does not matter: EVERY index is the same alone as it is in sequence", () => {
  // The whole first 2,000 rather than one lucky index: the failure this guards against only shows up
  // where a name collides, and index 900 may well not collide. A single-index version of this test
  // passed against an implementation that was genuinely order-dependent.
  const inSequence = corpusPatients(DEFAULT_CORPUS_SEED, 2000);
  for (let i = 0; i < 2000; i += 1) {
    const alone = patientAt(DEFAULT_CORPUS_SEED, i);
    assert.deepEqual({ ...alone, name: undefined }, { ...inSequence[i]!, name: undefined }, `index ${i} differs outside the name`);
  }
  // The NAME is the one field allowed to differ, and only by disambiguation against lower indices.
  const collided = inSequence.filter((p, i) => p.name !== patientAt(DEFAULT_CORPUS_SEED, i).name);
  for (const p of collided) assert.match(p.name, /^\S+ (?:[A-Z]|\d{5})\. /, `${p.externalId} differs but is not a disambiguation`);
});

test("a different seed produces a different corpus", () => {
  assert.notDeepEqual(patientAt("other-seed", 5000), patientAt(DEFAULT_CORPUS_SEED, 5000));
});

test("the first 100 patients hash to a pinned value — a silent generator drift fails here", () => {
  const digest = createHash("sha256").update(JSON.stringify(corpusPatients(DEFAULT_CORPUS_SEED, 100)), "utf8").digest("hex");
  // Recorded 2026-09-05 against CORPUS_GENERATOR_VERSION 1.1.0. If this fails, the generator's DRAW
  // ORDER or the parameter table changed: bump CORPUS_GENERATOR_VERSION and re-record here, in the
  // same commit as the change that moved it — never re-record it on its own.
  assert.equal(digest, "3c34ca47ddce57848ad42d2611b11afe4e7e4376f5c9379f736b02aec1fecee3");
});

test("every patient lands in a real clinic with a PCP at that clinic", () => {
  const byId = new Map(PCPS.map((p) => [p.id, p]));
  const names = new Set(CLINICS.map((c) => c.name));
  for (const p of corpusPatients(DEFAULT_CORPUS_SEED, 2000)) {
    assert.ok(names.has(p.site), `${p.externalId} is at unknown clinic ${p.site}`);
    assert.equal(byId.get(p.providerId)?.location, p.site, `${p.externalId}'s PCP is not at their clinic`);
  }
});

test("no duplicate (name, dateOfBirth) pair across the full 20,000", () => {
  const seen = new Set<string>();
  for (const p of corpusPatients(DEFAULT_CORPUS_SEED, 20000)) {
    const key = `${p.name}|${p.dateOfBirth}`;
    assert.ok(!seen.has(key), `duplicate identity: ${key} at ${p.externalId}`);
    seen.add(key);
  }
});

test("distributions land inside their tolerances over the full 20,000", () => {
  const all = corpusPatients(DEFAULT_CORPUS_SEED, 20000);
  for (const [name, weight] of [["Wailuku Clinic", 0.28], ["Kahului Clinic", 0.26], ["Kihei Clinic", 0.20], ["Lahaina Clinic", 0.16], ["Pukalani Clinic", 0.10]] as const) {
    const share = all.filter((p) => p.site === name).length / all.length;
    assert.ok(Math.abs(share - weight) < 0.02, `${name}: ${(share * 100).toFixed(1)}% vs ${weight * 100}%`);
  }
  for (const pcp of PCPS) {
    const panel = all.filter((p) => p.providerId === pcp.id).length;
    assert.ok(panel >= 350 && panel <= 650, `${pcp.id} panel ${panel} outside 350-650`);
  }
  const ages = all.map((p) => p.age).sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)]!;
  assert.ok(median >= 48 && median <= 56, `age median ${median}`);
  const female = all.filter((p) => p.sex === "F").length / all.length;
  assert.ok(female >= 0.50 && female <= 0.54, `female share ${(female * 100).toFixed(1)}%`);
});
