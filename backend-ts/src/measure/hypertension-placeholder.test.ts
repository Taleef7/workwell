import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MEASURE_CATALOG } from "./measure-catalog.ts";

const cqlPath = fileURLToPath(new URL("../../measures/hypertension.cql", import.meta.url));
const yamlPath = fileURLToPath(new URL("../../measures/hypertension.yaml", import.meta.url));
const valueSetSeedPath = fileURLToPath(new URL("./value-set-seed.ts", import.meta.url));
const elmPath = fileURLToPath(new URL("../engine/cql/elm/HypertensionBPScreeningCQL-1.0.0.elm.json", import.meta.url));

test("hypertension exposes clinical define names in authored CQL and compiled ELM", () => {
  const cql = readFileSync(cqlPath, "utf8");
  const elm = JSON.parse(readFileSync(elmPath, "utf8")) as {
    library?: { statements?: { def?: Array<{ name?: string }> } };
  };
  const defineNames = (elm.library?.statements?.def ?? []).map((define) => define.name);

  assert.match(cql, /define "In Eligible Population":/);
  assert.match(cql, /define "Has Documented Exclusion":/);
  assert.doesNotMatch(cql, /define "In Wellness Program"|define "Has Medical Exemption"/);
  assert.ok(defineNames.includes("In Eligible Population"));
  assert.ok(defineNames.includes("Has Documented Exclusion"));
  assert.ok(!defineNames.includes("In Wellness Program"));
  assert.ok(!defineNames.includes("Has Medical Exemption"));
});

test("hypertension catalog metadata is a clinical CMS165 placeholder", () => {
  const yaml = readFileSync(yamlPath, "utf8");
  const valueSetSeed = readFileSync(valueSetSeedPath, "utf8");
  const measure = MEASURE_CATALOG.find((entry) => entry.id === "hypertension");
  assert.ok(measure);
  assert.match(yaml, /^name: Hypertension BP Screening$/m);
  assert.match(yaml, /^policyRef: "Placeholder: CMS165 Controlling High Blood Pressure pending"$/m);
  assert.match(yaml, /^tags: \[clinical, hypertension, cardiovascular\]$/m);
  assert.match(valueSetSeed, /c\("wellness-enrolled", "Eligible population"/);
  assert.match(valueSetSeed, /c\("wellness-exempt", "Documented exclusion"/);
  assert.equal(measure.name, "Hypertension BP Screening");
  assert.equal(measure.policyRef, "Placeholder: CMS165 Controlling High Blood Pressure pending");
  assert.equal(measure.spec.description, "Adults with a documented blood pressure reading in the last 12 months (placeholder until CMS165 is onboarded).");
  assert.equal(measure.spec.eligibilityCriteria.programEnrollmentText, "Eligible population");
  assert.deepEqual(measure.spec.exclusions.map((exclusion) => exclusion.label), ["Documented exclusion"]);
  assert.deepEqual(measure.spec.requiredDataElements, ["Last BP reading date", "Exclusion status"]);
});
