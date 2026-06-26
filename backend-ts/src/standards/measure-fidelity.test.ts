import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFidelity } from "./measure-fidelity.ts";
import { CMS122V14 } from "./references/cms122v14.ts";

test("computeFidelity: assembles a report with reconciling summary counts", () => {
  const r = computeFidelity(CMS122V14);
  assert.equal(r.ecqmId, "CMS122v14");
  assert.equal(r.measureId, "cms122");
  // counts reconcile with the criteria
  assert.equal(r.summary.covered + r.summary.simplified + r.summary.omitted, r.criteria.length);
  assert.equal(r.criteria.length, CMS122V14.criteria.length);
  // official value-set count is the reference's; workwell count is the distinct represented local sets
  assert.equal(r.summary.officialValueSetCount, CMS122V14.valueSets.length);
  assert.equal(r.summary.workwellValueSetCount, 2); // diabetes + hba1c
});

test("computeFidelity: classifies the headline criteria correctly", () => {
  const r = computeFidelity(CMS122V14);
  const byKey = Object.fromEntries(r.criteria.map((c) => [c.key, c.coverage]));
  assert.equal(byKey["age-18-75"], "OMITTED");
  assert.equal(byKey["qualifying-visit"], "OMITTED");
  assert.equal(byKey["hospice"], "OMITTED");
  assert.equal(byKey["hba1c-gmi-gt9-or-missing"], "SIMPLIFIED");
  assert.equal(byKey["numerator-exclusions-none"], "COVERED");
});

test("computeFidelity: value-set fidelity marks the exclusion concepts unrepresented", () => {
  const r = computeFidelity(CMS122V14);
  const byConcept = Object.fromEntries(r.valueSets.map((v) => [v.concept, v.workwellRepresented]));
  assert.equal(byConcept["Diabetes"], true);
  assert.equal(byConcept["HbA1c"], true);
  assert.equal(byConcept["Hospice"], false);
  assert.equal(byConcept["Frailty"], false);
  assert.equal(byConcept["Palliative"], false);
});

test("computeFidelity: a plain-English headline + disclaimer are present", () => {
  const r = computeFidelity(CMS122V14);
  assert.ok(r.summary.headline.length > 0);
  assert.match(r.disclaimer, /structural/i);
});
