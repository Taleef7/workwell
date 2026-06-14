/**
 * Case disposition logic tests (#107).
 *   node --import tsx --test src/case/case-logic.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispositionFor, priorityFor, nextActionFor } from "./case-logic.ts";

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
  assert.match(nextActionFor("DUE_SOON", "flu_vaccine"), /Schedule the annual flu vaccine/);
});
