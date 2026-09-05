/**
 * Case disposition logic tests (#107).
 *   node --import tsx --test src/case/case-logic.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispositionFor, priorityFor, nextActionFor, NEXT_ACTION_LABELS, planCaseUpsert } from "./case-logic.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

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
  assert.match(nextActionFor("OVERDUE", "tb_surveillance"), /No TB screening on file for this measurement period\. Order or document one\./);
  assert.match(nextActionFor("MISSING_DATA", "audiogram"), /No audiogram result could be found\. Check for outside records before ordering\./);
  assert.match(nextActionFor("DUE_SOON", "flu_vaccine"), /A flu vaccine is due before the end of this measurement period\./);
});

test("nextActionFor EXCLUDED wording follows the deployment profile", () => {
  const excludedChildScript = `
    import { DEPLOYMENT_PROFILE } from "./src/config/deployment-profile.ts";
    import { nextActionFor } from "./src/case/case-logic.ts";
    console.log(JSON.stringify({ profileId: DEPLOYMENT_PROFILE.id, excludedAction: nextActionFor("EXCLUDED", "cms125") }));
  `;
  const maui = runProfileChild("maui", excludedChildScript);
  assert.equal(maui.profileId, "maui");
  assert.equal(maui.excludedAction, "Review the documented exclusion and rerun before it lapses.");
  const def = runProfileChild(undefined, excludedChildScript);
  assert.equal(def.profileId, "default");
  assert.equal(def.excludedAction, "Review the active waiver and rerun before it expires.");
});

test("nextActionFor is measure-aware for non-OSHA measures (M1: no longer defaults to 'audiogram')", () => {
  // The pre-fix bug mislabeled every non-OSHA measure's action as "audiogram".
  assert.match(nextActionFor("MISSING_DATA", "diabetes_hba1c"), /HbA1c test/);
  assert.match(nextActionFor("OVERDUE", "cms125"), /mammogram/);
  assert.match(nextActionFor("DUE_SOON", "adult_immunization"), /Td\/Tdap immunization/);
  assert.match(nextActionFor("MISSING_DATA", "hepatitis_b_vaccination_series"), /Hepatitis B series not documented as complete/);
  // none of these non-audiogram measures may leak the word "audiogram"
  for (const m of ["diabetes_hba1c", "cms125", "adult_immunization", "mmr", "varicella", "obesity_bmi"]) {
    assert.doesNotMatch(nextActionFor("MISSING_DATA", m), /audiogram/);
  }
});

test("nextActionFor: cms122 OVERDUE names both readings of the inverse numerator (poor control OR no result), never 'no HbA1c on file' alone", () => {
  const action = nextActionFor("OVERDUE", "cms122");
  assert.match(action, /glycemic status assessment \(HbA1c or GMI\) is above 9%/);
  assert.match(action, /or none is on file/);
  assert.match(action, /most recent qualifying assessment in the period is at or below 9%/, "states what closes the gap, in the measure's own terms");
  assert.doesNotMatch(action, /^No .* on file/);
  assert.doesNotMatch(action, /Order or document one/);
  // DUE_SOON uses the generic wording with the assessment noun, which must not narrow the measure to
  // HbA1c (it also reads GMI).
  assert.match(nextActionFor("DUE_SOON", "cms122"), /A glycemic status assessment \(HbA1c or GMI\) is due/);
});

test("nextActionFor: on the official-routed measures MISSING_DATA means 'not in the initial population', never 'no result could be found'", () => {
  for (const m of ["cms122", "cms125"]) {
    const action = nextActionFor("MISSING_DATA", m);
    assert.match(action, /Not in this measure's initial population/);
    assert.doesNotMatch(action, /could be found|before ordering/);
  }
  // Authored measures keep the data-gap reading: their MISSING_DATA really is a missing result.
  assert.match(nextActionFor("MISSING_DATA", "audiogram"), /No audiogram result could be found/);
});

test("nextActionFor: refusal-capable immunization OVERDUE wording is true whether or not a refusal is documented", () => {
  assert.equal(
    nextActionFor("OVERDUE", "adult_immunization"),
    "Td/Tdap not current. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
  assert.equal(
    nextActionFor("OVERDUE", "mmr"),
    "MMR 2-dose series not documented as complete. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
  assert.equal(
    nextActionFor("OVERDUE", "varicella"),
    "Varicella 2-dose series not documented as complete. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
  assert.equal(
    nextActionFor("OVERDUE", "hepatitis_b_vaccination_series"),
    "Hepatitis B series not documented as complete. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
});

test("nextActionFor: refusal-capable immunization MISSING_DATA wording is true whether or not a refusal is documented", () => {
  assert.equal(
    nextActionFor("MISSING_DATA", "adult_immunization"),
    "Td/Tdap not documented as current. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
  assert.equal(
    nextActionFor("MISSING_DATA", "mmr"),
    "MMR 2-dose series not documented as complete. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
  assert.equal(
    nextActionFor("MISSING_DATA", "varicella"),
    "Varicella 2-dose series not documented as complete. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
  assert.equal(
    nextActionFor("MISSING_DATA", "hepatitis_b_vaccination_series"),
    "Hepatitis B series not documented as complete. Review the record for a documented refusal or contraindication; otherwise order or document a dose.",
  );
});

test("nextActionFor: refusal-capable immunization overrides never assert a record's absence or a refusal", () => {
  for (const measureId of ["adult_immunization", "mmr", "varicella", "hepatitis_b_vaccination_series"]) {
    for (const outcomeStatus of ["OVERDUE", "MISSING_DATA"]) {
      const action = nextActionFor(outcomeStatus, measureId);
      assert.doesNotMatch(action, /No .+ on file/);
      assert.doesNotMatch(action, /not on file/);
      assert.doesNotMatch(action, /could be found/);
      assert.doesNotMatch(action, /declined/i);
      assert.doesNotMatch(action, /refused/i);
    }
  }
});

test("nextActionFor: an unknown measure falls back to a generic noun, never 'audiogram'", () => {
  const action = nextActionFor("MISSING_DATA", "not_a_real_measure");
  assert.match(action, /required screening/);
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

test("planCaseUpsert (Codex P2): a SYSTEM-EXCLUDED case reopens when the outcome becomes actionable (waiver lapsed)", () => {
  // A waiver that has since been removed/expired: CQL no longer returns EXCLUDED, the latest outcome is
  // OVERDUE, so the auto-excluded case must reopen (audited) rather than persist with a stale outcome.
  const plan = planCaseUpsert(st("EXCLUDED", "EXCLUDED", null), "OVERDUE", NOW);
  assert.equal(plan.op, "update");
  assert.equal(plan.status, "OPEN");
  assert.equal(plan.disposition, "REOPENED");
  assert.equal(plan.closedAt, null);
  assert.equal(plan.closedReason, null);
});

test("planCaseUpsert (Codex P2): a HUMAN-excluded case (closed_by set) stays closed even when actionable again", () => {
  assert.deepEqual(planCaseUpsert(st("EXCLUDED", "EXCLUDED", "admin@workwell.dev"), "OVERDUE", NOW), { op: "noop" });
});
// Task 8: routed measures read the official display table before the persisted authored overrides.
test("official-routed nextActionFor reads the official display table first", () => {
  // Save and RESTORE rather than delete: this process runs the whole file, and deleting a variable
  // that was set before the test leaves every later test reading a different deployment.
  const prior = process.env.WORKWELL_OFFICIAL_MEASURES;
  process.env.WORKWELL_OFFICIAL_MEASURES = "cms122";
  try {
    // The action is an ACTION. The reason the case is open is the method/why line's job; repeating it
    // here renders the same sentence twice in the case view.
    assert.equal(nextActionFor("OVERDUE", "cms122"), "Review glycemic control.");
    assert.notEqual(nextActionFor("OVERDUE", "cms122"), nextActionFor("OVERDUE", "cms125"));
  } finally {
    if (prior === undefined) delete process.env.WORKWELL_OFFICIAL_MEASURES;
    else process.env.WORKWELL_OFFICIAL_MEASURES = prior;
  }
});
