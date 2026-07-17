import { test } from "node:test";
import assert from "node:assert/strict";
import { rerunToVerify, type RerunDeps } from "./case-rerun.ts";
import type { CaseRecord } from "../stores/case-store.ts";

const existing: CaseRecord = {
  id: "case-wc", employeeId: "wc|rerun-patient", measureId: "audiogram", evaluationPeriod: "2026-01-01",
  status: "OPEN", priority: "HIGH", assignee: null, nextAction: "Verify", currentOutcomeStatus: "OVERDUE",
  lastRunId: "run-existing", createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
  closedAt: null, closedReason: null, closedBy: null,
};

test("rerunToVerify — wc CASE is a typed unsupported result before every mutation", async () => {
  const mutations: string[] = [];
  const mutated = (name: string) => async () => { mutations.push(name); throw new Error(`unexpected mutation: ${name}`); };
  const deps = {
    cases: { getCase: async () => existing, patchCase: mutated("case"), listCases: async () => [existing], upsertFromOutcome: mutated("case"), countByLastRun: async () => 1 },
    events: { recordCaseEvent: mutated("audit"), appendAudit: mutated("audit"), caseTimeline: async () => [], latestOutreachDeliveryStatus: async () => null },
    outcomes: { recordOutcome: mutated("outcome"), listOutcomes: async () => [] },
    runStore: { createRun: mutated("run"), markRunning: mutated("run"), appendLog: mutated("run"), finalizeRun: mutated("run"), listRuns: async () => [] },
    engine: { evaluate: mutated("engine") },
  } as unknown as RerunDeps;

  await assert.rejects(
    () => rerunToVerify(deps, existing.id, "tester"),
    (error: unknown) => (error as { code?: string }).code === "unsupported_scope",
  );
  assert.deepEqual(mutations, [], "no run/outcome/case/audit/engine mutation occurred");
  assert.deepEqual(await deps.cases.listCases({}), [existing], "existing case state is unchanged");
  assert.deepEqual(await deps.outcomes.listOutcomes(existing.lastRunId), [], "existing outcome state is unchanged");
  assert.deepEqual(await deps.runStore.listRuns(), [], "run count is unchanged");
});
