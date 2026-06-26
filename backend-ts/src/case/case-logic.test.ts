/**
 * Case disposition logic tests (#107).
 *   node --import tsx --test src/case/case-logic.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispositionFor, priorityFor, nextActionFor, NEXT_ACTION_LABELS } from "./case-logic.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

test("dispositionFor routes outcomes to OPEN / EXCLUDED / RESOLVE", () => {
  for (const s of ["OVERDUE", "DUE_SOON", "MISSING_DATA"]) assert.equal(dispositionFor(s), "OPEN");
  assert.equal(dispositionFor("EXCLUDED"), "EXCLUDED");
  assert.equal(dispositionFor("COMPLIANT"), "RESOLVE");
});

test("priorityFor: OVERDUE=HIGH, DUE_SOON/MISSING_DATA=MEDIUM, else LOW", () => {
  assert.equal(priorityFor("OVERDUE"), "HIGH");
  assert.equal(priorityFor("DUE_SOON"), "MEDIUM");
  assert.equal(priorityFor("MISSING_DATA"), "MEDIUM");
  assert.equal(priorityFor("COMPLIANT"), "LOW");
});

test("nextActionFor uses the measure label + outcome", () => {
  assert.match(nextActionFor("OVERDUE", "tb_surveillance"), /Escalate TB screening/);
  assert.match(nextActionFor("MISSING_DATA", "audiogram"), /Collect the missing audiogram/);
  assert.match(nextActionFor("DUE_SOON", "flu_vaccine"), /Schedule the flu vaccine before the due date/);
});

test("nextActionFor is measure-aware for non-OSHA measures (M1: no longer defaults to 'audiogram')", () => {
  // The pre-fix bug mislabeled every non-OSHA measure's action as "audiogram".
  assert.match(nextActionFor("MISSING_DATA", "diabetes_hba1c"), /HbA1c test/);
  assert.match(nextActionFor("OVERDUE", "cms125"), /mammogram/);
  assert.match(nextActionFor("DUE_SOON", "adult_immunization"), /Td\/Tdap immunization/);
  assert.match(nextActionFor("MISSING_DATA", "hepatitis_b_vaccination_series"), /hepatitis B vaccination/);
  // none of these non-audiogram measures may leak the word "audiogram"
  for (const m of ["diabetes_hba1c", "cms125", "adult_immunization", "mmr", "varicella", "obesity_bmi"]) {
    assert.doesNotMatch(nextActionFor("MISSING_DATA", m), /audiogram/);
  }
});

test("nextActionFor: an unknown measure falls back to a generic noun, never 'audiogram'", () => {
  const action = nextActionFor("MISSING_DATA", "not_a_real_measure");
  assert.match(action, /compliance assessment/);
  assert.doesNotMatch(action, /audiogram/);
});

test("NEXT_ACTION_LABELS covers every runnable measure (regression guard for new measures)", () => {
  for (const measureId of Object.keys(MEASURES)) {
    assert.ok(
      NEXT_ACTION_LABELS[measureId],
      `measure '${measureId}' has no specific next-action label — add one to NEXT_ACTION_LABELS`,
    );
  }
});
