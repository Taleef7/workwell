/**
 * Case disposition logic tests (#107).
 *   node --import tsx --test src/case/case-logic.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispositionFor, priorityFor, nextActionFor, NEXT_ACTION_LABELS, planCaseUpsert } from "./case-logic.ts";
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

// --- planCaseUpsert: state-aware upsert (Fable H1/H2) -----------------------
const NOW = "2026-07-02T00:00:00.000Z";
const st = (status: string, currentOutcomeStatus: string, closedBy: string | null = null) => ({ status, currentOutcomeStatus, closedBy });

test("planCaseUpsert: no existing case → CREATE on non-compliant, EXCLUDE on excluded, no-op on compliant", () => {
  assert.deepEqual(planCaseUpsert(null, "OVERDUE", NOW), { op: "insert", disposition: "CREATED", status: "OPEN", closedAt: null, closedReason: null, closedBy: null });
  assert.deepEqual(planCaseUpsert(null, "EXCLUDED", NOW), { op: "insert", disposition: "EXCLUDED", status: "EXCLUDED", closedAt: NOW, closedReason: "EXCLUDED", closedBy: null });
  assert.deepEqual(planCaseUpsert(null, "COMPLIANT", NOW), { op: "noop" });
});

test("planCaseUpsert H2: IN_PROGRESS is preserved on a still-non-compliant rerun (not flipped to OPEN)", () => {
  const plan = planCaseUpsert(st("IN_PROGRESS", "OVERDUE"), "OVERDUE", NOW);
  assert.equal(plan.op, "update");
  assert.equal(plan.status, "IN_PROGRESS");
  assert.equal(plan.disposition, "UNCHANGED"); // same outcome → no audit noise
});

test("planCaseUpsert: an OPEN case whose outcome CHANGES (DUE_SOON→OVERDUE) is an audited UPDATE", () => {
  const plan = planCaseUpsert(st("OPEN", "DUE_SOON"), "OVERDUE", NOW);
  assert.equal(plan.op, "update");
  assert.equal(plan.status, "OPEN");
  assert.equal(plan.disposition, "UPDATED");
});

test("planCaseUpsert H2: a re-confirmed OPEN case (same outcome) refreshes silently (UNCHANGED, no audit)", () => {
  assert.equal(planCaseUpsert(st("OPEN", "OVERDUE"), "OVERDUE", NOW).disposition, "UNCHANGED");
});

test("planCaseUpsert H2: a HUMAN-closed case is respected — a still-non-compliant run does NOT reopen it", () => {
  assert.deepEqual(planCaseUpsert(st("RESOLVED", "COMPLIANT", "cm@workwell.dev"), "OVERDUE", NOW), { op: "noop" });
});

test("planCaseUpsert H2: a SYSTEM auto-resolved case reopens (audited) when the subject is non-compliant again", () => {
  const plan = planCaseUpsert(st("RESOLVED", "COMPLIANT", null), "OVERDUE", NOW);
  assert.equal(plan.op, "update");
  assert.equal(plan.status, "OPEN");
  assert.equal(plan.disposition, "REOPENED");
  assert.equal(plan.closedAt, null);
  assert.equal(plan.closedReason, null);
});

test("planCaseUpsert H2: COMPLIANT resolves an OPEN case, but is a no-op on an already-terminal one (no closed_at drift)", () => {
  const resolve = planCaseUpsert(st("OPEN", "OVERDUE"), "COMPLIANT", NOW);
  assert.deepEqual(resolve, { op: "update", disposition: "RESOLVED", status: "RESOLVED", closedAt: NOW, closedReason: "AUTO_RESOLVED", closedBy: null });
  assert.deepEqual(planCaseUpsert(st("RESOLVED", "COMPLIANT", null), "COMPLIANT", NOW), { op: "noop" });
});

test("planCaseUpsert: an already-EXCLUDED case is a no-op on a repeat EXCLUDED outcome", () => {
  assert.deepEqual(planCaseUpsert(st("EXCLUDED", "EXCLUDED", null), "EXCLUDED", NOW), { op: "noop" });
});
