/**
 * An operator's `next_action` survives a run that learned nothing new (issue #530).
 *
 * The upsert recomputed the action from the outcome and wrote it unconditionally, so the nightly run
 * replaced whatever a person had put there: a case escalated at 4pm read the wording table's line the
 * next morning, and the outreach path's "Wait for the patient's follow-up, then rerun to verify
 * closure." never survived a night. #529 made that overwrite AUDITED, which made it visible without
 * making it right.
 *
 * `planNextAction` is the pure rule, mirroring the one `IN_PROGRESS` already has. These tests pin the
 * boundary in both directions — what is preserved, and what correctly takes over — because a rule that
 * only ever preserves would strand a case on an instruction written about a situation that has passed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planNextAction } from "./case-logic.ts";

const OPERATOR = "Call the patient; they asked for an evening appointment.";
const COMPUTED = "Review breast imaging history; order or document screening if none exists.";

const existing = (over: Partial<{ nextAction: string | null; nextActionSource: string | null; currentOutcomeStatus: string }> = {}) => ({
  nextAction: OPERATOR,
  nextActionSource: "OPERATOR",
  currentOutcomeStatus: "OVERDUE",
  ...over,
});

test("a re-confirmed outcome leaves an operator's instruction alone", () => {
  assert.deepEqual(planNextAction(existing(), COMPUTED, "OVERDUE"), { nextAction: OPERATOR, source: "OPERATOR" });
});

test("a CHANGED outcome hands the action back to the system", () => {
  // The instruction was written about being OVERDUE. Once CQL says something else it is stale advice,
  // and keeping it would be the mirror image of the defect: an operator's words outliving their subject.
  assert.deepEqual(planNextAction(existing(), COMPUTED, "DUE_SOON"), { nextAction: COMPUTED, source: "SYSTEM" });
  assert.deepEqual(planNextAction(existing({ currentOutcomeStatus: "MISSING_DATA" }), COMPUTED, "OVERDUE"), {
    nextAction: COMPUTED,
    source: "SYSTEM",
  });
});

test("a system-owned action is recomputed every run, so wording-table edits still land", () => {
  assert.deepEqual(planNextAction(existing({ nextActionSource: "SYSTEM" }), COMPUTED, "OVERDUE"), {
    nextAction: COMPUTED,
    source: "SYSTEM",
  });
  // A multi-rate measure's action follows the rate the subject missed (ADR-074 d13). That is a system
  // reading and must keep moving — the #529 behaviour is unchanged for SYSTEM-owned rows.
  assert.deepEqual(planNextAction(existing({ nextActionSource: "SYSTEM", nextAction: "rate 1's line" }), "rate 2's line", "OVERDUE"), {
    nextAction: "rate 2's line",
    source: "SYSTEM",
  });
});

test("a new case, and a legacy row with no source or no action, are system-owned", () => {
  assert.deepEqual(planNextAction(null, COMPUTED, "OVERDUE"), { nextAction: COMPUTED, source: "SYSTEM" });
  // Every row written before the column existed had its action written by a run, so SYSTEM is the true
  // answer for it rather than a placeholder.
  assert.deepEqual(planNextAction(existing({ nextActionSource: null }), COMPUTED, "OVERDUE"), {
    nextAction: COMPUTED,
    source: "SYSTEM",
  });
  // OPERATOR with a null action is not a preservable instruction — there is nothing to preserve.
  assert.deepEqual(planNextAction(existing({ nextAction: null }), COMPUTED, "OVERDUE"), {
    nextAction: COMPUTED,
    source: "SYSTEM",
  });
});
