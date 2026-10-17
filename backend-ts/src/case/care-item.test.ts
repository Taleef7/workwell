import { test } from "node:test";
import assert from "node:assert/strict";
import { NEUTRAL_CARE_ITEM, SENSITIVE_MEASURES, careItemFor, joinCareItems } from "./care-item.ts";
import { PATIENT_TEMPLATES } from "./case-outreach.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";

test("Q1: each Maui measure is a plain care item; CMS2 and CMS137 are never named", () => {
  assert.equal(careItemFor("cms125"), "a mammogram");
  assert.equal(careItemFor("cms130"), "a colorectal cancer screening");
  assert.equal(careItemFor("cms122"), "an A1c blood test");
  assert.equal(careItemFor("cms165"), "a blood pressure check");
  for (const id of SENSITIVE_MEASURES) assert.equal(careItemFor(id), NEUTRAL_CARE_ITEM, id);
  assert.equal(careItemFor("constructor"), NEUTRAL_CARE_ITEM, "an inherited key is not a phrase");
});

test("Q1: one message lists each care item once", () => {
  assert.equal(joinCareItems(["cms125"]), "a mammogram");
  assert.equal(joinCareItems(["cms125", "cms122"]), "a mammogram and an A1c blood test");
  assert.equal(joinCareItems(["cms125", "cms122", "cms165"]), "a mammogram, an A1c blood test and a blood pressure check");
  assert.equal(joinCareItems(["cms2", "cms137"]), NEUTRAL_CARE_ITEM, "two sensitive gaps read as one visit, naming neither");
  assert.equal(joinCareItems([]), NEUTRAL_CARE_ITEM);
});

test("Q1 guard: no patient message can carry a measure's title, id, or a CMS/MIPS identifier", () => {
  for (const template of Object.values(PATIENT_TEMPLATES)) {
    assert.doesNotMatch(template.subject + template.bodyText, /\{\{measureName\}\}/, `${template.id} renders the catalog title`);
  }
  for (const measure of MEASURE_CATALOG) {
    for (const template of Object.values(PATIENT_TEMPLATES)) {
      const message = (template.subject + " " + template.bodyText)
        .replaceAll("{{employeeName}}", "Pat")
        .replaceAll("{{careItem}}", careItemFor(measure.id));
      assert.ok(!message.includes(measure.name), `${measure.id}: "${message}" names the measure`);
      assert.ok(!message.toLowerCase().includes(measure.id.toLowerCase()), `${measure.id}: the message carries the id`);
      assert.doesNotMatch(message, /\bCMS\d|\bMIPS\b|\{\{/, `${measure.id}: "${message}"`);
    }
  }
});
