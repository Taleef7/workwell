/**
 * Fable H3 regression: HAZWOPER + TB CQL must scope their enrollment/exemption Conditions by CODE,
 * not match ANY Condition. The synthetic pipeline masked the bug (per-measure bundles only ever
 * carry that measure's own conditions), but the advertised real-data path (evaluateBundle / the E2
 * CLI) accepts arbitrary FHIR bundles: pre-fix, a patient with two unrelated Conditions evaluated
 * EXCLUDED for TB, and any one Condition made a patient "In HAZWOPER Program".
 *   node --import tsx --test src/engine/cql/foreign-condition-scoping.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateBundle } from "../ingress/evaluate-bundle.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): { entry?: Array<{ resource?: Record<string, unknown> }> } =>
  JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

/** A Condition with a code that belongs to no WorkWell value set (a real patient's unrelated dx). */
const foreignCondition = (patientRef: string, code: string) => ({
  resource: {
    resourceType: "Condition",
    subject: { reference: patientRef },
    code: { coding: [{ system: "http://snomed.info/sct", code }] },
  },
});

const defineResult = (outcome: { evidence?: unknown }, name: string): unknown => {
  const ers = (outcome.evidence as { expressionResults?: Array<{ define: string; result: unknown }> } | undefined)?.expressionResults ?? [];
  return ers.find((e) => e.define === name)?.result;
};

test("TB: two unrelated Conditions do NOT make a patient EXCLUDED (was Count([Condition]) > 1)", async () => {
  const patientRef = "Patient/foreign-tb";
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "foreign-tb" } },
      foreignCondition(patientRef, "11111"),
      foreignCondition(patientRef, "22222"),
    ],
  };
  const got = await evaluateBundle(bundle, "tb_surveillance", { evaluationDate: EVAL });
  assert.notEqual(got.outcome, "EXCLUDED", "unrelated conditions must not trigger the medical exemption");
  assert.equal(got.outcome, "MISSING_DATA", "not in the program (no tb-program enrollment) → MISSING_DATA");
  assert.equal(defineResult(got, "In TB Screening Program"), false, "foreign conditions do not enroll");
  assert.equal(defineResult(got, "Has Medical Exemption"), false, "foreign conditions are not an exemption");
});

test("HAZWOPER: unrelated Conditions do NOT enroll a patient or exclude them (was exists/Count([Condition]))", async () => {
  const patientRef = "Patient/foreign-haz";
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "foreign-haz" } },
      foreignCondition(patientRef, "33333"),
      foreignCondition(patientRef, "44444"),
    ],
  };
  const got = await evaluateBundle(bundle, "hazwoper", { evaluationDate: EVAL });
  assert.notEqual(got.outcome, "EXCLUDED", "unrelated conditions must not trigger the medical exemption");
  assert.equal(defineResult(got, "In HAZWOPER Program"), false, "any-Condition no longer enrolls");
  assert.equal(defineResult(got, "Has Medical Exemption"), false, "foreign conditions are not an exemption");
});

test("TB: injecting foreign Conditions into a COMPLIANT bundle does not corrupt the outcome", async () => {
  // present_recent is COMPLIANT (1 tb-program enrollment condition). Pre-fix, adding 2 more conditions
  // made Count([Condition]) > 1 true → EXCLUDED. Post-fix the outcome is unchanged.
  const bundle = load("tb_surveillance", "present_recent");
  const patientRef = "Patient/tb_surveillance-present_recent";
  bundle.entry = [...(bundle.entry ?? []), foreignCondition(patientRef, "55555"), foreignCondition(patientRef, "66666")];
  const got = await evaluateBundle(bundle, "tb_surveillance", { evaluationDate: EVAL });
  assert.equal(got.outcome, "COMPLIANT", "foreign conditions do not flip a compliant subject to EXCLUDED");
});
