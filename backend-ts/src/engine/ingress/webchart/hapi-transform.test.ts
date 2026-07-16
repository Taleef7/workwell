/**
 * Collection→transaction transform for the local HAPI "fake WebChart" loader (ADR-032).
 *   node --import tsx --test src/engine/ingress/webchart/hapi-transform.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toTransactionBundle, toTransactionBundles } from "./hapi-transform.ts";

const obs = (loinc: string, extra?: Record<string, unknown>) => ({
  resourceType: "Observation",
  status: "final",
  subject: { reference: "Patient/wc-5" },
  code: { coding: [{ system: "http://loinc.org", code: loinc }] },
  ...extra,
});

const fixture = () => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id: "wc-5", gender: "female" } },
    { resource: obs("4548-4") },
    { resource: obs("2089-1") },
    { resource: { resourceType: "Procedure", status: "completed", subject: { reference: "Patient/wc-5" } } },
  ],
});

test("patient entry becomes PUT Patient/{id} with the fixture id preserved", () => {
  const tx = toTransactionBundle(fixture());
  assert.equal(tx.resourceType, "Bundle");
  assert.equal(tx.type, "transaction");
  const patient = tx.entry[0]!;
  assert.equal(patient.request.method, "PUT");
  assert.equal(patient.request.url, "Patient/wc-5");
  assert.equal(patient.fullUrl, "Patient/wc-5");
  assert.equal(patient.resource.id, "wc-5");
});

test("id-less clinical resources get deterministic minted ids, per-type ordinals, and PUTs", () => {
  const tx = toTransactionBundle(fixture());
  const urls = tx.entry.map((e) => e.request.url);
  assert.deepEqual(urls, [
    "Patient/wc-5",
    "Observation/wc-5-observation-1",
    "Observation/wc-5-observation-2",
    "Procedure/wc-5-procedure-1",
  ]);
  for (const e of tx.entry) {
    assert.equal(e.request.method, "PUT");
    assert.equal(e.fullUrl, e.request.url);
    assert.equal(e.resource.id, e.request.url.split("/")[1]);
  }
});

test("a resource that already carries an id keeps it (never re-minted)", () => {
  const f = fixture();
  (f.entry[1]!.resource as Record<string, unknown>).id = "existing-obs";
  const tx = toTransactionBundle(f);
  assert.equal(tx.entry[1]!.request.url, "Observation/existing-obs");
  // the ordinal still advances for the type, so the NEXT id-less Observation is stable
  assert.equal(tx.entry[2]!.request.url, "Observation/wc-5-observation-2");
});

test("transform is deterministic (re-running yields a deep-equal bundle — idempotent re-loads)", () => {
  assert.deepEqual(toTransactionBundle(fixture()), toTransactionBundle(fixture()));
});

test("resource content is preserved; the input is never mutated", () => {
  const f = fixture();
  const tx = toTransactionBundle(f);
  const loaded = tx.entry[1]!.resource as Record<string, any>;
  assert.equal(loaded.subject.reference, "Patient/wc-5");
  assert.equal(loaded.code.coding[0].code, "4548-4");
  // input untouched — its Observation still has no id
  assert.equal((f.entry[1]!.resource as Record<string, unknown>).id, undefined);
});

test("a bundle without an id-carrying Patient fails loudly (unmatchable data must not load)", () => {
  assert.throws(() => toTransactionBundle({ resourceType: "Bundle", entry: [{ resource: obs("4548-4") }] }), /no Patient/);
  assert.throws(() => toTransactionBundle({ resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient" } }] }), /no Patient/);
});

test("non-Bundle / malformed inputs are rejected", () => {
  assert.throws(() => toTransactionBundle(null), /expected a FHIR Bundle/);
  assert.throws(() => toTransactionBundle({ resourceType: "Patient" }), /expected a FHIR Bundle/);
  assert.throws(() => toTransactionBundles({}), /expected an array/);
});

test("the whole committed fixture file transforms cleanly (56 patients, all entries PUT-addressed)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const file = fileURLToPath(new URL("../../../../spike/webchart/devdb-patients.json", import.meta.url));
  const bundles = toTransactionBundles(JSON.parse(readFileSync(file, "utf8")));
  assert.equal(bundles.length, 56);
  const ids = new Set<string>();
  for (const tx of bundles) {
    for (const e of tx.entry) {
      assert.equal(e.request.method, "PUT");
      assert.match(e.request.url, /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/);
      assert.equal(ids.has(e.request.url), false, `duplicate resource address: ${e.request.url}`);
      ids.add(e.request.url);
    }
  }
});
