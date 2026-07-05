import { test } from "node:test";
import assert from "node:assert/strict";
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";
import { CompositeValueSetResolver, isVsacOid } from "./composite-value-set-resolver.ts";

function stub(tag: string): ValueSetResolver {
  return { expand: (url) => Promise.resolve([{ code: tag, system: url }] as CqlCode[]) };
}

test("isVsacOid matches dotted numeric OIDs, not URNs/URLs", () => {
  assert.equal(isVsacOid("2.16.840.1.113883.3.464.1003.103.12.1001"), true);
  assert.equal(isVsacOid("urn:workwell:vs:audiogram-procedures"), false);
  assert.equal(isVsacOid("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840"), false);
  assert.equal(isVsacOid("Audiogram Procedures"), false);
});

test("real OID routes to the vsac tier", async () => {
  const c = new CompositeValueSetResolver(stub("vsac"), stub("store"));
  const codes = await c.expand("2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(codes[0]!.code, "vsac");
});

test("urn:workwell:* routes to the store tier", async () => {
  const c = new CompositeValueSetResolver(stub("vsac"), stub("store"));
  const codes = await c.expand("urn:workwell:vs:audiogram-procedures");
  assert.equal(codes[0]!.code, "store");
});
