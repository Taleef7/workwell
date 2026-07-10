import { test } from "node:test";
import assert from "node:assert/strict";
import { CMS122V14 } from "./cms122v14.ts";
import { referenceFor } from "./index.ts";

test("CMS122v14 reference has identity + provenance", () => {
  assert.equal(CMS122V14.ecqmId, "CMS122v14");
  assert.equal(CMS122V14.version, "14.0.000");
  assert.equal(CMS122V14.measureId, "cms122");
  assert.ok(CMS122V14.provenance.sourceUrl.startsWith("https://ecqi.healthit.gov"));
});

test("CMS122v14 reference represents all five populations", () => {
  const pops = new Set(CMS122V14.criteria.map((c) => c.population));
  for (const p of ["IPP", "DENOM", "DENEX", "NUMER", "NUMEX"]) assert.ok(pops.has(p as never), `missing population ${p}`);
});

test("CMS122v14 reference: every criterion has a coverage + note; every value set has an oid + concept", () => {
  for (const c of CMS122V14.criteria) {
    assert.ok(["COVERED", "SIMPLIFIED", "OMITTED"].includes(c.coverage), `bad coverage on ${c.key}`);
    assert.ok(c.note.length > 0, `empty note on ${c.key}`);
  }
  for (const vs of CMS122V14.valueSets) {
    assert.match(vs.oid, /^2\.16\.840\./);
    assert.ok(vs.concept.length > 0);
  }
});

test("referenceFor resolves cms122 and cms125; undefined for measures without a reference", () => {
  assert.equal(referenceFor("cms122")?.ecqmId, "CMS122v14");
  assert.equal(referenceFor("cms125")?.ecqmId, "CMS125v14");
  assert.equal(referenceFor("audiogram"), undefined);
});
