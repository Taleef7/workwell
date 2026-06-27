/**
 * Scale-tenant structure + subject_id codec (#185 E13 PR-2).
 *   node --import tsx --test src/engine/synthetic/scale-structure.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCALE_TENANT, SCALE_LOCATIONS, scaleProvidersFor, encodeScaleSubject, decodeScaleSubject, isScaleSubject,
} from "./scale-structure.ts";

test("scale tenant + structure are deterministic and sized", () => {
  assert.equal(SCALE_TENANT.id, "mhn");
  assert.equal(SCALE_LOCATIONS.length, 24);
  for (const loc of SCALE_LOCATIONS) assert.equal(scaleProvidersFor(loc.id).length, 10);
});

test("codec round-trips and identifies scale subjects", () => {
  const id = encodeScaleSubject(7, 3, 123);
  assert.equal(id, "mhn|L07|P03|0000123");
  assert.ok(isScaleSubject(id));
  assert.ok(!isScaleSubject("emp-006"));
  const d = decodeScaleSubject(id);
  assert.deepEqual(d, { tenantId: "mhn", locationId: "L07", providerId: "P03", n: 123 });
  assert.equal(decodeScaleSubject("emp-006"), null);
});

test("location/provider ids match the codec's L../P.. format", () => {
  assert.ok(SCALE_LOCATIONS.every((l) => /^L\d\d$/.test(l.id)));
  assert.ok(scaleProvidersFor("L00").every((p) => /^P\d\d$/.test(p.id)));
});
