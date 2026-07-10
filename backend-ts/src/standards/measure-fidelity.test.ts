import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFidelity } from "./measure-fidelity.ts";
import { CMS122V14 } from "./references/cms122v14.ts";
import { CMS125V14 } from "./references/cms125v14.ts";

test("computeFidelity CMS122: assembles a report with reconciling summary counts", () => {
  const r = computeFidelity(CMS122V14);
  assert.equal(r.ecqmId, "CMS122v14");
  assert.equal(r.measureId, "cms122");
  assert.equal(r.summary.covered + r.summary.simplified + r.summary.omitted, r.criteria.length);
  assert.equal(r.criteria.length, CMS122V14.criteria.length);
  assert.equal(r.summary.officialValueSetCount, CMS122V14.valueSets.length);
});

test("computeFidelity CMS122: production-faithful coverages (2026-07)", () => {
  const r = computeFidelity(CMS122V14);
  const byKey = Object.fromEntries(r.criteria.map((c) => [c.key, c.coverage]));
  assert.equal(byKey["age-18-75"], "COVERED");
  assert.equal(byKey["qualifying-visit"], "COVERED");
  assert.equal(byKey["hospice"], "COVERED");
  assert.equal(byKey["palliative-care"], "COVERED");
  assert.equal(byKey["long-term-care-66"], "OMITTED");
  assert.equal(byKey["advanced-illness-frailty-66"], "OMITTED");
  assert.equal(byKey["hba1c-gmi-gt9-or-missing"], "SIMPLIFIED");
  assert.equal(byKey["numerator-exclusions-none"], "COVERED");
});

test("computeFidelity CMS122: value-set fidelity marks hospice/palliative represented", () => {
  const r = computeFidelity(CMS122V14);
  const byConcept = Object.fromEntries(r.valueSets.map((v) => [v.concept, v.workwellRepresented]));
  assert.equal(byConcept["Diabetes"], true);
  assert.equal(byConcept["HbA1c"], true);
  assert.equal(byConcept["Hospice"], true);
  assert.equal(byConcept["Palliative"], true);
  assert.equal(byConcept["Frailty"], false);
});

test("computeFidelity CMS122: headline + disclaimer present", () => {
  const r = computeFidelity(CMS122V14);
  assert.ok(r.summary.headline.length > 0);
  assert.match(r.summary.headline, new RegExp(String(r.summary.omitted)));
  assert.match(r.summary.headline, /frailty|LTC|Phase 2/i);
  assert.match(r.disclaimer, /structural/i);
});

test("computeFidelity CMS125: production-faithful coverages (2026-07)", () => {
  const r = computeFidelity(CMS125V14);
  assert.equal(r.ecqmId, "CMS125v14");
  assert.equal(r.measureId, "cms125");
  assert.equal(r.summary.covered + r.summary.simplified + r.summary.omitted, r.criteria.length);
  const byKey = Object.fromEntries(r.criteria.map((c) => [c.key, c.coverage]));
  assert.equal(byKey["female-42-74"], "COVERED");
  assert.equal(byKey["mammogram-oct1-window"], "COVERED");
  assert.equal(byKey["mastectomy"], "COVERED");
  assert.equal(byKey["long-term-care-66"], "OMITTED");
  assert.equal(byKey["advanced-illness-frailty-66"], "OMITTED");
});
