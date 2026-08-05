import { test } from "node:test";
import assert from "node:assert/strict";
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";
import { CompositeValueSetResolver, isVsacOid, vsacOid } from "./composite-value-set-resolver.ts";

function stub(tag: string): ValueSetResolver {
  return { expand: (url) => Promise.resolve([{ code: tag, system: url }] as CqlCode[]) };
}

test("isVsacOid matches bare OIDs and urn:oid:-wrapped OIDs, not other URNs/URLs", () => {
  assert.equal(isVsacOid("2.16.840.1.113883.3.464.1003.103.12.1001"), true);
  assert.equal(isVsacOid("urn:oid:2.16.840.1.113883.3.464.1003.103.12.1001"), true);
  assert.equal(isVsacOid("urn:workwell:vs:audiogram-procedures"), false);
  assert.equal(isVsacOid("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840"), false);
  assert.equal(isVsacOid("Audiogram Procedures"), false);
});

test("vsacOid strips the urn:oid: wrapper to the bare OID", () => {
  assert.equal(vsacOid("urn:oid:2.16.840.1.113883.3.464.1003.103.12.1001"), "2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(vsacOid("2.16.840.1.113883.3.464.1003.103.12.1001"), "2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(vsacOid("urn:workwell:vs:audiogram-procedures"), null);
});

test("real OID routes to the vsac tier", async () => {
  const c = new CompositeValueSetResolver(stub("vsac"), stub("store"));
  const codes = await c.expand("2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(codes[0]!.code, "vsac");
});

test("urn:oid: reference routes to the vsac tier with the BARE oid (Codex P2)", async () => {
  // The vsac stub echoes the id it received into `system`; assert it got the bare OID, not urn:oid:.
  const c = new CompositeValueSetResolver(stub("vsac"), stub("store"));
  const codes = await c.expand("urn:oid:2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(codes[0]!.code, "vsac");
  assert.equal(codes[0]!.system, "2.16.840.1.113883.3.464.1003.103.12.1001");
});

test("urn:workwell:* routes to the store tier", async () => {
  const c = new CompositeValueSetResolver(stub("vsac"), stub("store"));
  const codes = await c.expand("urn:workwell:vs:audiogram-procedures");
  assert.equal(codes[0]!.code, "store");
});
