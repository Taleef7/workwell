import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

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

test("escalation copy follows the deployment profile", () => {
  const maui = runProfileChild("maui", ESCALATE_CHILD_SOURCE);
  assert.equal(maui.nextAction, "Escalated for immediate handling.");
  const defaultProfile = runProfileChild(undefined, ESCALATE_CHILD_SOURCE);
  assert.equal(
    defaultProfile.nextAction,
    "Escalated to supervisor queue for immediate handling.",
  );
});
