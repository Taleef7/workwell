/**
 * #263 Phase 2a — canonical bundle hashing golden tests. The load-bearing guarantees (design §5):
 *   1. A MATERIAL clinical edit ALWAYS moves the hash (a missed change = a stale wrong answer).
 *   2. Object-key reordering, bundle-entry reordering, and volatile server metadata NEVER move it
 *      (a false invalidation just wastes CPU, but at scale that defeats the whole feature).
 *   node --import tsx --test src/run/incremental/canonical-hash.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeForHash, hashBundle } from "./canonical-hash.ts";

const bundle = (entries: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  resourceType: "Bundle",
  type: "collection",
  ...extra,
  entry: entries,
});

const patient = { resource: { resourceType: "Patient", id: "p1", name: [{ family: "Doe", given: ["A"] }] } };
const obs = (id: string, value: number, date: string) => ({
  resource: {
    resourceType: "Observation",
    id,
    code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
    valueQuantity: { value },
    effectiveDateTime: date,
  },
});

test("hash is stable across object-key reordering", async () => {
  const a = bundle([patient, obs("o1", 120, "2026-01-01")]);
  const b = bundle([{ resource: { effectiveDateTime: "2026-01-01", valueQuantity: { value: 120 }, resourceType: "Observation", id: "o1", code: { coding: [{ code: "8480-6", system: "http://loinc.org" }] } } }, { resource: { name: [{ given: ["A"], family: "Doe" }], id: "p1", resourceType: "Patient" } }]);
  assert.equal(await hashBundle(a), await hashBundle(b));
});

test("hash is stable across bundle-entry reordering (no clinical meaning)", async () => {
  const a = bundle([patient, obs("o1", 120, "2026-01-01"), obs("o2", 80, "2026-01-01")]);
  const b = bundle([obs("o2", 80, "2026-01-01"), obs("o1", 120, "2026-01-01"), patient]);
  assert.equal(await hashBundle(a), await hashBundle(b));
});

test("volatile server metadata (meta.lastUpdated/versionId, Bundle.timestamp, entry.fullUrl) is ignored", async () => {
  const a = bundle([patient, obs("o1", 120, "2026-01-01")]);
  const noisy = bundle(
    [
      { fullUrl: "https://server/Patient/p1", resource: { ...patient.resource, meta: { lastUpdated: "2026-07-24T10:00:00Z", versionId: "7" } } },
      { fullUrl: "https://server/Observation/o1", resource: { ...obs("o1", 120, "2026-01-01").resource, meta: { versionId: "3" } } },
    ],
    { timestamp: "2026-07-24T10:00:00Z" },
  );
  assert.equal(await hashBundle(a), await hashBundle(noisy));
});

test("a NON-volatile meta field (e.g. profile) still counts", async () => {
  const a = bundle([{ resource: { ...patient.resource, meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"] } } }]);
  const b = bundle([{ resource: { ...patient.resource, meta: { profile: ["http://example.org/other"] } } }]);
  assert.notEqual(await hashBundle(a), await hashBundle(b));
});

test("MATERIAL edits move the hash — new resource", async () => {
  const a = bundle([patient, obs("o1", 120, "2026-01-01")]);
  const b = bundle([patient, obs("o1", 120, "2026-01-01"), obs("o2", 80, "2026-01-01")]);
  assert.notEqual(await hashBundle(a), await hashBundle(b));
});

test("MATERIAL edits move the hash — changed value", async () => {
  const a = bundle([patient, obs("o1", 120, "2026-01-01")]);
  const b = bundle([patient, obs("o1", 145, "2026-01-01")]);
  assert.notEqual(await hashBundle(a), await hashBundle(b));
});

test("MATERIAL edits move the hash — changed date", async () => {
  const a = bundle([patient, obs("o1", 120, "2026-01-01")]);
  const b = bundle([patient, obs("o1", 120, "2026-02-15")]);
  assert.notEqual(await hashBundle(a), await hashBundle(b));
});

test("MATERIAL edits move the hash — changed code", async () => {
  const a = bundle([patient, obs("o1", 120, "2026-01-01")]);
  const changed = obs("o1", 120, "2026-01-01");
  (changed.resource.code.coding[0] as { code: string }).code = "9999-9";
  const b = bundle([patient, changed]);
  assert.notEqual(await hashBundle(a), await hashBundle(b));
});

test("inner arrays keep order — reordering Observation.component IS a change", async () => {
  const comp = (codes: string[]) => ({
    resource: {
      resourceType: "Observation",
      id: "bp",
      component: codes.map((c) => ({ code: { coding: [{ code: c }] }, valueQuantity: { value: 1 } })),
    },
  });
  const a = bundle([comp(["8480-6", "8462-4"])]);
  const b = bundle([comp(["8462-4", "8480-6"])]);
  assert.notEqual(await hashBundle(a), await hashBundle(b));
});

test("volatile strip is LEVEL-SCOPED — a resource-level field named timestamp/fullUrl still counts (review #4)", async () => {
  // A `timestamp`/`fullUrl` NESTED inside a resource is clinical data the CQL could read, so a change
  // there must move the hash (only Bundle.timestamp + entry.fullUrl are transport wrappers).
  const withField = (v: string) => bundle([{ resource: { resourceType: "Observation", id: "o1", timestamp: v, fullUrl: v } }]);
  assert.notEqual(await hashBundle(withField("a")), await hashBundle(withField("b")));
});

test("output is the house sha256:<hex> format", async () => {
  const h = await hashBundle(bundle([patient]));
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
});

test("canonicalizeForHash is deterministic and volatile-free (exposed for debugging)", () => {
  const a = canonicalizeForHash(bundle([patient], { timestamp: "x" }));
  const b = canonicalizeForHash(bundle([patient]));
  assert.equal(a, b);
  assert.doesNotMatch(a, /timestamp/);
});
