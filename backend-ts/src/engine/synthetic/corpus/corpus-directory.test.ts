import test from "node:test";
import assert from "node:assert/strict";
import { corpusDirectory, corpusSizeFromEnv, DEFAULT_CORPUS_DIRECTORY_SIZE } from "./corpus-directory.ts";
import { PCPS, CLINICS, DEFAULT_CORPUS_SEED } from "./corpus-parameters.ts";

test("corpusDirectory yields `size` patients, the 40 providers and the maui tenant", () => {
  const dir = corpusDirectory(DEFAULT_CORPUS_SEED, 500);
  assert.equal(dir.EMPLOYEES.length, 500);
  assert.equal(dir.PROVIDERS.length, PCPS.length);
  assert.ok(dir.EMPLOYEES.every((e) => e.tenantId === "maui" && e.role === "Patient"));
  assert.ok(dir.EMPLOYEES.every((e) => CLINICS.some((c) => c.name === e.site)));
  // Every patient's PCP resolves, and resolves to somebody at their own clinic.
  for (const e of dir.EMPLOYEES) {
    const provider = dir.providerById(e.providerId);
    assert.ok(provider, `${e.externalId}: unknown provider ${e.providerId}`);
    assert.equal(provider!.location, e.site, `${e.externalId}: PCP is at a different clinic`);
    assert.ok(dir.employeeById(e.externalId), `${e.externalId}: not resolvable by id`);
  }
  assert.deepEqual(dir.TENANTS.map((t) => t.id), ["maui"]);
  assert.equal(dir.employeesForTenant("maui").length, 500);
  assert.deepEqual(dir.employeesForTenant("twh"), []);
  assert.ok(dir.enterpriseForTenant("maui"), "the maui enterprise resolves");
  assert.equal(dir.enterpriseForTenant("twh"), null);
});

test("the default size is the 48-patient fixture prefix", () => {
  assert.deepEqual(
    corpusDirectory(DEFAULT_CORPUS_SEED, 48).EMPLOYEES.map((e) => e.externalId),
    Array.from({ length: 48 }, (_, i) => `pat-${String(i + 1).padStart(3, "0")}`),
  );
});

test("providersForLocation returns only that clinic's PCPs", () => {
  const dir = corpusDirectory(DEFAULT_CORPUS_SEED, 200);
  assert.equal(dir.providersForLocation("Kahului Clinic").length, 10);
  assert.ok(dir.providersForLocation("Kahului Clinic").every((p) => p.location === "Kahului Clinic"));
  assert.deepEqual(dir.providersForLocation("Nowhere Clinic"), []);
  // Every clinic is represented, and the parts sum to the whole — a lookup that quietly dropped a
  // clinic would still pass the two assertions above.
  const total = CLINICS.reduce((n, c) => n + dir.providersForLocation(c.name).length, 0);
  assert.equal(total, PCPS.length);
});

test("corpusSizeFromEnv reads a positive integer and refuses to throw on a bad one", () => {
  assert.equal(corpusSizeFromEnv({}), DEFAULT_CORPUS_DIRECTORY_SIZE);
  assert.equal(corpusSizeFromEnv({ WORKWELL_MAUI_CORPUS_SIZE: "" }), DEFAULT_CORPUS_DIRECTORY_SIZE);
  assert.equal(corpusSizeFromEnv({ WORKWELL_MAUI_CORPUS_SIZE: "20000" }), 20000);
  // A malformed value must not stop a worker booting — it degrades to the default, loudly.
  for (const bad of ["abc", "-1", "0", "12.5"]) {
    assert.equal(corpusSizeFromEnv({ WORKWELL_MAUI_CORPUS_SIZE: bad }), DEFAULT_CORPUS_DIRECTORY_SIZE, `bad value ${bad}`);
  }
});

test("the fixture prefix spreads across its clinics' panels, not onto one PCP each", () => {
  // The default 48-patient deployment is what the pilot's staff see; collapsing each clinic onto its
  // first PCP would leave the PCP filter with two panels and nothing to demonstrate.
  const dir = corpusDirectory(DEFAULT_CORPUS_SEED, 48);
  const panels = new Set(dir.EMPLOYEES.map((e) => e.providerId));
  assert.ok(panels.size >= 8, `48 fixture patients sit on only ${panels.size} panels`);
  for (const e of dir.EMPLOYEES) assert.equal(dir.providerById(e.providerId)!.location, e.site);
});
