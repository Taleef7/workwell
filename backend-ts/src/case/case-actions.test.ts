import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";
import { escalateCase, CaseActionError, type CaseActionDeps } from "./case-actions.ts";

const ESCALATE_CHILD_SOURCE = `
  import { escalateCase } from "./src/case/case-actions.ts";

  const existingCase = {
    id: "case-1",
    lastRunId: "run-1",
    employeeId: "subject-1",
    measureId: "measure-1",
    status: "OPEN",
    priority: "NORMAL",
    assignee: null,
    nextAction: null,
  };
  let patched = null;
  const deps = {
    cases: {
      getCase: async () => existingCase,
      patchCase: async (_id, patch) => { patched = patch; },
    },
    events: {
      recordCaseEvent: async ({ action, audit }) => ({ action, audit }),
      caseTimeline: async () => [],
      latestOutreachDeliveryStatus: async () => null,
    },
    outcomes: { listOutcomes: async () => [] },
  };
  const detail = await escalateCase(deps, "case-1", "actor-1");
  assert.ok(detail);
  console.log(JSON.stringify({ nextAction: patched?.nextAction }));
`;

test("a closed, resolved or excluded case cannot be escalated: it would reopen silently (#618 review)", async () => {
  for (const status of ["CLOSED", "RESOLVED", "EXCLUDED", "IN_PROGRESS"]) {
    let patched = false;
    let recorded = 0;
    const deps = {
      cases: {
        getCase: async () => ({ id: "case-1", lastRunId: "run-1", employeeId: "subject-1", measureId: "measure-1", status, priority: "NORMAL", assignee: null, nextAction: null }),
        patchCase: async () => { patched = true; },
      },
      events: {
        recordCaseEvent: async (x: unknown) => { recorded++; return x; },
        caseTimeline: async () => [],
        latestOutreachDeliveryStatus: async () => null,
      },
      outcomes: { listOutcomes: async () => [] },
    } as unknown as CaseActionDeps;
    if (status === "IN_PROGRESS") {
      assert.ok(await escalateCase(deps, "case-1", "actor-1"), "an active case still escalates");
      assert.equal(recorded, 1);
      assert.equal(patched, true);
    } else {
      await assert.rejects(() => escalateCase(deps, "case-1", "actor-1"), CaseActionError, status);
      assert.equal(recorded, 0, `${status}: no event for a refused escalation`);
      assert.equal(patched, false, `${status}: the case is untouched`);
    }
  }
});

test("escalation copy follows the deployment profile", () => {
  const maui = runProfileChild("maui", ESCALATE_CHILD_SOURCE);
  assert.equal(maui.nextAction, "Escalated for immediate handling.");
  const defaultProfile = runProfileChild(undefined, ESCALATE_CHILD_SOURCE);
  assert.equal(
    defaultProfile.nextAction,
    "Escalated to supervisor queue for immediate handling.",
  );
});
